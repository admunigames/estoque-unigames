import { getD1 } from "../../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../../lib/notion";
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, contentDisposition, documentsBucket } from "../../../../../../documents/shared";
import { canSeeRequest, identity, loadRequest, routeParam, safeText } from "../../../../../shared";

// Abre/baixa um anexo do item (?attachmentId=) — quem vê o pedido vê o
// anexo. Mesmo padrão de resposta binária do Compras (sandbox, no-store).

type Context = { params: Promise<{ id: string; itemId: string }> };

function fileError(message: string, status: number) {
  return new Response(message, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

async function serve(request: Request, context: Context, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const url = new URL(request.url);
  const attachmentId = safeText(url.searchParams.get("attachmentId"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return fileError("ANEXO INVÁLIDO.", 400);
  try {
    const params = await context.params;
    const requestId = routeParam(params.id);
    const database = await getD1();
    const row = await loadRequest(database, requestId);
    const attachment = row
      ? await database
        .prepare(
          `SELECT r2_key AS r2Key, file_name AS fileName, content_type AS contentType
           FROM divergence_item_attachments WHERE id=?1 AND item_id=?2 AND request_id=?3`,
        )
        .bind(attachmentId, routeParam(params.itemId), requestId)
        .first<{ r2Key: string; fileName: string; contentType: string }>()
      : null;
    if (!row || !attachment || !canSeeRequest(actor, row.companyId)) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);
    const bucket = await documentsBucket();
    const object = head ? await bucket.head(attachment.r2Key) : await bucket.get(attachment.r2Key);
    if (!object) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);
    return new Response(head ? null : (object as R2ObjectBody).body, {
      headers: {
        "content-type": attachment.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
        "content-disposition": contentDisposition(attachment.fileName, url.searchParams.get("download") === "1"),
        "content-length": String(object.size),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  } catch (error) {
    console.error("Não foi possível abrir o anexo da divergência.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ARQUIVO.", 500);
  }
}

export const GET = (request: Request, context: Context) => serve(request, context);
export const HEAD = (request: Request, context: Context) => serve(request, context, true);
