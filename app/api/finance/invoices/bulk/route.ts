import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import {
  assertInvoiceAccess,
  canReconcileInvoices,
  loadInstallments,
  loadInvoice,
  planInvoiceCancel,
  planInvoiceReview,
  type InvoiceRow,
} from "../shared";

// Ações em lote de NOTAS FISCAIS (Financeiro 9/9): { action, ids, fields }
// - review: CONFERIR (só aguardando conferência — mesma regra do individual);
// - category: ALTERAR CATEGORIA (fields.financeItemId — pula NF com duplicata,
//   como a edição individual) e/ou CENTRO DE CUSTO (fields.costCenterId);
// - cancel: CANCELAR (fields.reason) — NF com duplicata paga é pulada (cancele
//   pela tela da nota, decidindo o que fazer com o pago).
// A NF não é excluída nem tem a competência alterada em lugar nenhum da tela.
// Todos os ids conferidos antes (404/403); uma transação.

const ACTIONS = ["review", "category", "cancel"];

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canReconcileInvoices(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR NOTAS FISCAIS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (!ACTIONS.includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA NOTA FISCAL." }, 400);
    if (ids.length > 300) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 300)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const financeItemId = safeText(fields.financeItemId, 80);
    const costCenterChanged = fields.costCenterId !== undefined;
    const costCenterId = safeText(fields.costCenterId, 80);
    let categoryId = "";
    let costCenterName = "";
    if (action === "category") {
      if (!financeItemId && !costCenterChanged) return jsonResponse({ error: "ESCOLHA A CATEGORIA OU O CENTRO DE CUSTO." }, 400);
      if (financeItemId) {
        const item = await database.prepare("SELECT category_id AS categoryId FROM finance_items WHERE id=?1").bind(financeItemId).first<{ categoryId: string }>();
        if (!item) return jsonResponse({ error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO." }, 400);
        categoryId = item.categoryId || "";
      }
      if (costCenterId) {
        const row = await database.prepare("SELECT name FROM finance_cost_centers WHERE id=?1").bind(costCenterId).first<{ name: string }>();
        if (!row) return jsonResponse({ error: "CENTRO DE CUSTO NÃO ENCONTRADO." }, 400);
        costCenterName = row.name;
      }
    }

    const invoices: InvoiceRow[] = [];
    for (const id of ids) {
      const invoice = await loadInvoice(database, id);
      if (!invoice) return jsonResponse({ error: "ALGUMA NOTA FISCAL SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
      const accessError = assertInvoiceAccess(scopeActor, invoice);
      if (accessError) return jsonResponse({ error: accessError }, 403);
      invoices.push(invoice);
    }

    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const statements: [string, unknown[]][] = [];
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    for (const invoice of invoices) {
      const skip = (reason: string) => skipped.push({ id: invoice.id, description: `NF ${invoice.invoiceNumber}`, reason });
      if (invoice.canceled) { skip("NOTA FISCAL CANCELADA"); continue; }
      if (action === "review") {
        const plan = await planInvoiceReview(database, invoice, who);
        if ("error" in plan) { skip(plan.error); continue; }
        statements.push(...plan.statements);
        continue;
      }
      const installments = await loadInstallments(database, invoice.id);
      if (action === "cancel") {
        if (installments.some((row) => !row.canceled && Number(row.paidAmountCents) > 0)) {
          skip("NOTA COM DUPLICATA PAGA — CANCELE PELA TELA DA NOTA");
          continue;
        }
        statements.push(...(await planInvoiceCancel(database, invoice, who, safeText(fields.reason, 500))));
        continue;
      }
      const nextItem = financeItemId || invoice.financeItemId;
      if (nextItem !== invoice.financeItemId && installments.length) {
        skip("NÃO É POSSÍVEL TROCAR O ITEM FINANCEIRO DEPOIS DE CADASTRAR DUPLICATAS");
        continue;
      }
      statements.push([
        `UPDATE supplier_invoices SET finance_category_id=?1, finance_item_id=?2, cost_center=?3, cost_center_id=?4,
           updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP WHERE id=?7`,
        [
          financeItemId ? categoryId : invoice.financeCategoryId,
          nextItem,
          costCenterChanged ? costCenterName : invoice.costCenter,
          costCenterChanged ? costCenterId || null : invoice.costCenterId,
          who.id, who.name, invoice.id,
        ],
      ]);
    }
    if (statements.length) await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied: invoices.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de notas fiscais.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
