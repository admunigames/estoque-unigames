import { getD1 } from "../../../../../../db";
import { canPurchases, unauthorizedResponse } from "../../../../../lib/notion";
import { computeInvoiceFinancialStatus } from "../../../../../lib/supplier-invoice-status";
import { loadInvoice, invoiceEventStatement } from "../../../../finance/invoices/shared";

type JsonMap = Record<string, unknown>;

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identity(request: Request) {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
  };
}

function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim() || "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

// "Enviar ao Financeiro" — ação exclusiva de Compras (permissão dedicada
// purchases:send_to_finance, granular e separada de purchases:edit, ver
// worker/index.ts). Só existe reenvio quando a NF foi devolvida
// (pending_correction=1); enviar de novo sem devolução é bloqueado.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canPurchases(request, "purchases:send_to_finance")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ENVIAR A NOTA FISCAL AO FINANCEIRO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const { id } = await context.params;
  const notionPurchaseId = id.trim();

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supplier_invoices WHERE notion_purchase_id=?1 ORDER BY created_at DESC LIMIT 1")
      .bind(notionPurchaseId)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "CADASTRE A NOTA FISCAL ANTES DE ENVIAR AO FINANCEIRO." }, 404);

    const invoice = await loadInvoice(database, existing.id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    if (invoice.canceled) return jsonResponse({ error: "ESTA NOTA FISCAL ESTÁ CANCELADA." }, 409);
    if (invoice.sentToFinanceAt && !invoice.pendingCorrection) {
      return jsonResponse({ error: "ESTA NOTA FISCAL JÁ FOI ENVIADA AO FINANCEIRO." }, 409);
    }
    if (!invoice.supplierId) return jsonResponse({ error: "SELECIONE O FORNECEDOR ANTES DE ENVIAR." }, 400);
    if (!invoice.invoiceNumber) return jsonResponse({ error: "INFORME O NÚMERO DA NOTA FISCAL ANTES DE ENVIAR." }, 400);
    if (!invoice.totalAmountCents || invoice.totalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME O VALOR TOTAL DA NOTA FISCAL ANTES DE ENVIAR." }, 400);
    }
    if (!invoice.competenceMonth) return jsonResponse({ error: "INFORME A COMPETÊNCIA DA NOTA FISCAL ANTES DE ENVIAR." }, 400);
    if (!invoice.financeItemId) {
      return jsonResponse(
        { error: "SELECIONE O ITEM FINANCEIRO/CATEGORIA DA NOTA FISCAL ANTES DE ENVIAR." },
        400,
      );
    }

    const actor = identity(request);
    const actorName = actor.displayName || "Usuário";
    const isResend = Boolean(invoice.pendingCorrection);
    const financialStatus = computeInvoiceFinancialStatus({
      totalAmountCents: invoice.totalAmountCents,
      canceled: false,
      sentToFinance: true,
      reviewed: false,
      installments: [],
    });

    const statements = [
      [
        `UPDATE supplier_invoices
         SET financial_status=?1, pending_correction=0, sent_to_finance_by=?2, sent_to_finance_by_name=?3,
             sent_to_finance_at=CURRENT_TIMESTAMP::text, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
        [financialStatus, actor.id, actorName, invoice.id],
      ] as [string, unknown[]],
      invoiceEventStatement({
        invoiceId: invoice.id,
        eventType: isResend ? "resent_to_finance" : "sent_to_finance",
        description: isResend ? "NOTA FISCAL REENVIADA AO FINANCEIRO APÓS CORREÇÃO." : "NOTA FISCAL ENVIADA AO FINANCEIRO.",
        actorId: actor.id,
        actorName,
      }),
    ];

    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ sent: true, id: invoice.id });
  } catch (error) {
    console.error("Não foi possível enviar a nota fiscal ao financeiro.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENVIAR A NOTA FISCAL AO FINANCEIRO." }, 500);
  }
}
