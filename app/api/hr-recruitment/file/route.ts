import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, contentDisposition, documentsBucket } from "../../documents/shared";
import { canViewRecruitment, identity, safeText } from "../shared";

// Abre/baixa o termo de integração assinado ou o print da reunião anexado a
// um candidato. Mesmo formato de app/api/hr-store-tracking/file/route.ts.

const COLUMN_PREFIX: Record<string, string> = {
  term: "integration_term",
  print: "integration_print",
};

type FileRow = {
  fileName: string;
  r2Key: string;
};

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function recruitmentFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewRecruitment(actor)) {
    return fileError("VOCÊ NÃO TEM ACESSO A ESTE ARQUIVO.", 403);
  }

  const url = new URL(request.url);
  const kind = safeText(url.searchParams.get("kind"), 20);
  const id = safeText(url.searchParams.get("id"), 80);
  const prefix = COLUMN_PREFIX[kind];
  if (!prefix || !/^[0-9a-f-]{36}$/i.test(id)) return fileError("REGISTRO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT ${prefix}_file_name AS fileName, ${prefix}_r2_key AS r2Key
         FROM hr_recruitment_candidates WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("CANDIDATO NÃO ENCONTRADO.", 404);
    if (!row.r2Key) return fileError("ESTE CANDIDATO NÃO TEM ESSE ARQUIVO ANEXADO.", 404);

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": object.httpMetadata?.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
      "content-disposition": contentDisposition(
        row.fileName || "anexo",
        url.searchParams.get("download") === "1",
      ),
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag: object.httpEtag,
    });
    const body = head ? null : (object as R2ObjectBody).body;
    return new Response(body, { headers });
  } catch (error) {
    console.error("Não foi possível abrir o arquivo do candidato.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ARQUIVO.", 500);
  }
}

export async function GET(request: Request) {
  return recruitmentFile(request);
}

export async function HEAD(request: Request) {
  return recruitmentFile(request, true);
}
