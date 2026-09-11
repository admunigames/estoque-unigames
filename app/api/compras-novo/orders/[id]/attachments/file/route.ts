import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { contentDisposition, documentsBucket } from "../../../../../documents/shared";
import { canManageComprasDraft, identity, safeText } from "../../../../shared";

// Abre/baixa um anexo PDF de um pedido nativo (arquivo do pedido ou nota
// fiscal) — mesmo padrão de resposta binária das demais rotas de arquivo do
// projeto (ver app/api/finance/mall-declarations/[id]/attachments/file/route.ts).

type FileRow = { fileName: string; r2Key: string; orderId: string };

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

async function serve(request: Request, orderId: string, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) return fileError("VOCÊ NÃO TEM ACESSO A ESTE ARQUIVO.", 403);

  const url = new URL(request.url);
  const attachmentId = safeText(url.searchParams.get("attachmentId"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return fileError("ANEXO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        "SELECT file_name AS fileName, r2_key AS r2Key, order_id AS orderId FROM purchase_order_attachments WHERE id=?1 LIMIT 1",
      )
      .bind(attachmentId)
      .first<FileRow>();
    if (!row || !row.r2Key || row.orderId !== orderId) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

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
    console.error("Não foi possível abrir o anexo do pedido.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ARQUIVO.", 500);
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return serve(request, id);
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return serve(request, id, true);
}
