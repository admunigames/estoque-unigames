import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, contentDisposition, documentsBucket } from "../../../documents/shared";
import { canViewUniformStock, identity, safeText, uuidIsValid } from "../../shared";

// Abre/baixa o termo de responsabilidade assinado de um casaco. Mesmo
// formato de app/api/hr-recruitment/file/route.ts.

type FileRow = { fileName: string; r2Key: string };

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function termFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewUniformStock(actor)) {
    return fileError("VOCÊ NÃO TEM ACESSO A ESTE ARQUIVO.", 403);
  }

  const url = new URL(request.url);
  const id = safeText(url.searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return fileError("REGISTRO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare("SELECT file_name AS fileName, r2_key AS r2Key FROM uniform_coat_terms WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("TERMO NÃO ENCONTRADO.", 404);
    if (!row.r2Key) return fileError("ESTE TERMO NÃO TEM ARQUIVO ANEXADO.", 404);

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": object.httpMetadata?.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
      "content-disposition": contentDisposition(row.fileName || "termo", url.searchParams.get("download") === "1"),
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag: object.httpEtag,
    });
    const body = head ? null : (object as R2ObjectBody).body;
    return new Response(body, { headers });
  } catch (error) {
    console.error("Não foi possível abrir o termo de responsabilidade.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ARQUIVO.", 500);
  }
}

export async function GET(request: Request) {
  return termFile(request);
}

export async function HEAD(request: Request) {
  return termFile(request, true);
}
