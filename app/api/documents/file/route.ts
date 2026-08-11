import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  contentDisposition,
  documentsBucket,
  safeDocumentText,
} from "../shared";

type FileRow = {
  fileName: string;
  r2Key: string;
  contentType: string;
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

async function documentFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const id = safeDocumentText(url.searchParams.get("id"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fileError("DOCUMENTO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT file_name AS fileName, r2_key AS r2Key, content_type AS contentType
         FROM documents WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("DOCUMENTO NÃO ENCONTRADO.", 404);

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO PDF NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": row.contentType || "application/pdf",
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
    console.error("Não foi possível abrir o documento.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O DOCUMENTO.", 500);
  }
}

export async function GET(request: Request) {
  return documentFile(request);
}

export async function HEAD(request: Request) {
  return documentFile(request, true);
}
