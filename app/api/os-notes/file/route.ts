import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany } from "../../../lib/access-scope";
import { contentDisposition, documentsBucket } from "../../documents/shared";

type Identity = {
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type FileRow = {
  companyId: string;
  fileName: string;
  r2Key: string;
};

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function identity(request: Request): Identity {
  return {
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canAccessOsNotes(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.some((permission) => permission.startsWith("os_notes:"))
  );
}

function canSeeAllOsNoteStores(actor: Identity) {
  return actor.role === "admin" || (!hasCompany(actor.companyId) && canAccessOsNotes(actor));
}

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function osNoteFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessOsNotes(actor)) {
    return fileError("VOCÊ NÃO TEM ACESSO ÀS NOTAS DE O.S.", 403);
  }

  const url = new URL(request.url);
  const id = safeText(url.searchParams.get("id"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fileError("SOLICITAÇÃO INVÁLIDA.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT company_id AS companyId, file_name AS fileName, r2_key AS r2Key
         FROM os_notes WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("SOLICITAÇÃO NÃO ENCONTRADA.", 404);
    if (!canSeeAllOsNoteStores(actor) && row.companyId !== actor.companyId) {
      return fileError("VOCÊ NÃO PODE ACESSAR O ANEXO DE OUTRA LOJA.", 403);
    }
    if (!row.r2Key) {
      return fileError("O ANEXO DESTA SOLICITAÇÃO JÁ FOI REMOVIDO (MAIS DE 30 DIAS).", 404);
    }

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO PDF NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(row.fileName, url.searchParams.get("download") === "1"),
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag: object.httpEtag,
    });
    const body = head ? null : (object as R2ObjectBody).body;
    return new Response(body, { headers });
  } catch (error) {
    console.error("Não foi possível abrir o anexo da nota de O.S.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ANEXO.", 500);
  }
}

export async function GET(request: Request) {
  return osNoteFile(request);
}

export async function HEAD(request: Request) {
  return osNoteFile(request, true);
}
