import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, contentDisposition, documentsBucket } from "../../../../../documents/shared";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../../../lib/access-scope";
import { identity, safeText } from "../../../../shared";
import { assertInvoiceAccess, canViewInvoices, loadInvoice } from "../../../shared";

// Abre/baixa um anexo de uma NF do Financeiro (upload manual ou
// reaproveitado do pedido de Compras no handoff) — mesmo padrão de resposta
// binária das demais rotas de arquivo do projeto (ver
// app/api/compras-novo/orders/[id]/attachments/file/route.ts).

type FileRow = {
  fileName: string;
  r2Key: string;
  invoiceId: string;
  installmentId: string;
  paymentId: string;
  contentType: string;
};

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

async function serve(request: Request, invoiceId: string, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewInvoices(actor)) return fileError("VOCÊ NÃO TEM ACESSO A ESTE ARQUIVO.", 403);

  const url = new URL(request.url);
  const attachmentId = safeText(url.searchParams.get("attachmentId"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return fileError("ANEXO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const invoice = await loadInvoice(database, invoiceId);
    if (!invoice) return fileError("NOTA FISCAL NÃO ENCONTRADA.", 404);

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const allStores = canSeeAllStores(scopeActor, "finance:manage");
    if (!allStores && !hasCompany(scopeActor.companyId)) return fileError(NO_COMPANY_ERROR, 403);
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return fileError(accessError, 403);

    const row = await database
      .prepare(
        `SELECT file_name AS fileName, r2_key AS r2Key, invoice_id AS invoiceId,
                installment_id AS installmentId, payment_id AS paymentId, content_type AS contentType
         FROM supplier_invoice_attachments WHERE id=?1 LIMIT 1`,
      )
      .bind(attachmentId)
      .first<FileRow>();
    if (!row || !row.r2Key) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const belongsToInvoice =
      row.invoiceId === invoiceId ||
      (row.installmentId &&
        (await database
          .prepare("SELECT 1 FROM supplier_invoice_installments WHERE id=?1 AND invoice_id=?2")
          .bind(row.installmentId, invoiceId)
          .first()));
    if (!belongsToInvoice) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": row.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
      "content-disposition": contentDisposition(
        row.fileName || "arquivo",
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
    console.error("Não foi possível abrir o anexo da nota fiscal.", error);
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
