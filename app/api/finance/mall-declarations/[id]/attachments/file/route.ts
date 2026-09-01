import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { contentDisposition, documentsBucket } from "../../../../../documents/shared";
import { canManageFinance, identity, safeText } from "../../../../shared";

// Abre/baixa um anexo PDF de uma declaração de shopping. Resposta binária
// com content-security-policy: sandbox, igual às demais rotas de arquivo.

type FileRow = { fileName: string; r2Key: string };

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

async function serve(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return fileError("VOCÊ NÃO TEM ACESSO A ESTE ARQUIVO.", 403);

  const url = new URL(request.url);
  const attachmentId = safeText(url.searchParams.get("attachmentId"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return fileError("ANEXO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        "SELECT file_name AS fileName, r2_key AS r2Key FROM finance_mall_declaration_attachments WHERE id=?1 LIMIT 1",
      )
      .bind(attachmentId)
      .first<FileRow>();
    if (!row || !row.r2Key) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO PDF NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(
        row.fileName || "documento.pdf",
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
    console.error("Não foi possível abrir o anexo da declaração.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ARQUIVO.", 500);
  }
}

export async function GET(request: Request) {
  return serve(request);
}

export async function HEAD(request: Request) {
  return serve(request, true);
}
