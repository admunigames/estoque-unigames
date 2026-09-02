import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { contentDisposition, documentsBucket } from "../../documents/shared";
import { UUID_PATTERN, canManageWorks, identity, safeText } from "../shared";

// Abre/baixa o anexo (nota/orçamento em PDF) de um lançamento de obra.
// Mesmo formato binário das Notas de O.S. (content-security-policy:
// sandbox), gateado por works:manage / finance:manage.

type FileRow = { attachmentFileName: string; attachmentR2Key: string };

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

async function obraFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageWorks(actor)) return fileError("VOCÊ NÃO TEM ACESSO AOS ANEXOS DE OBRA.", 403);

  const url = new URL(request.url);
  const id = safeText(url.searchParams.get("id"), 80);
  if (!UUID_PATTERN.test(id)) return fileError("LANÇAMENTO DE OBRA INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT attachment_file_name AS attachmentFileName, attachment_r2_key AS attachmentR2Key
         FROM obra_entries WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("LANÇAMENTO DE OBRA NÃO ENCONTRADO.", 404);
    if (!row.attachmentR2Key) return fileError("ESTE LANÇAMENTO NÃO TEM ANEXO.", 404);

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.attachmentR2Key) : await bucket.get(row.attachmentR2Key);
    if (!object) return fileError("ARQUIVO PDF NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(
        row.attachmentFileName || "anexo-obra.pdf",
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
    console.error("Não foi possível abrir o anexo da obra.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ANEXO.", 500);
  }
}

export async function GET(request: Request) {
  return obraFile(request);
}

export async function HEAD(request: Request) {
  return obraFile(request, true);
}
