import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../shared";
import { assertAccess, loadPayable, planPayablePayment, type PayableRow } from "../../../payables/shared";

// Ações em lote da LISTA DE PAGAMENTOS (só contas — RH é pago na Folha):
// { action: 'pay' | 'reschedule', ids: payableIds[], fields }.
// - pay: registra o pagamento CONFIRMADO do saldo em aberto de cada conta
//   (original − pago − agendados pendentes) na data/conta informadas, pela
//   mesma regra do POST payables/[id]/payments (planPayablePayment);
// - reschedule: troca o vencimento (fields.dueDate).
// Todos os ids são conferidos antes (404 se algum sumiu, 403 se for de outra
// loja); a gravação vai numa transação só. Cancelar/excluir continua só em
// Contas a Pagar.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR CONTAS A PAGAR." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "pay" && action !== "reschedule") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA CONTA." }, 400);
    if (ids.length > 300) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 300)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const paymentDate = safeText(fields.paymentDate, 10);
    const dueDate = safeText(fields.dueDate, 10);
    if (action === "pay" && !DATE_RE.test(paymentDate)) return jsonResponse({ error: "INFORME A DATA DO PAGAMENTO." }, 400);
    if (action === "reschedule" && !DATE_RE.test(dueDate)) return jsonResponse({ error: "INFORME O NOVO VENCIMENTO." }, 400);

    const database = await getD1();
    const payables: PayableRow[] = [];
    for (const id of ids) {
      const payable = await loadPayable(database, id);
      if (!payable) {
        return jsonResponse({ error: "ALGUMA CONTA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
      }
      const accessError = assertAccess(scopeActor, payable);
      if (accessError) return jsonResponse({ error: accessError }, 403);
      payables.push(payable);
    }

    const pending = await database
      .prepare(
        `SELECT payable_id AS payableId, SUM(amount_cents) AS total FROM accounts_payable_payments
         WHERE scheduled = 1 AND confirmed_at = '' AND payable_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
         GROUP BY payable_id`,
      )
      .bind(...ids)
      .all<{ payableId: string; total: number }>();
    const scheduledOf = new Map((pending.results ?? []).map((row) => [row.payableId, Number(row.total || 0)]));

    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const statements: [string, unknown[]][] = [];
    const actorName = actor.displayName || "Administrador";
    for (const payable of payables) {
      const skip = (reason: string) => skipped.push({ id: payable.id, description: payable.description, reason });
      if (payable.status === "canceled") { skip("CONTA CANCELADA"); continue; }
      if (payable.status === "paid") { skip("CONTA JÁ PAGA"); continue; }
      if (action === "reschedule") {
        statements.push([
          `UPDATE accounts_payable SET due_date=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
          [dueDate, actor.id, actorName, payable.id],
        ]);
        continue;
      }
      const openCents = payable.originalAmountCents - payable.paidAmountCents - (scheduledOf.get(payable.id) ?? 0);
      if (openCents <= 0) { skip("SALDO JÁ AGENDADO — CONFIRME O AGENDAMENTO EM CONTAS A PAGAR"); continue; }
      const plan = await planPayablePayment(database, payable, actor, {
        idempotencyKey: `cash-flow-bulk:${crypto.randomUUID()}`,
        amountCents: openCents,
        paymentDate,
        scheduled: false,
        paymentMethod: safeText(fields.paymentMethod, 40),
        financeAccountId: safeText(fields.financeAccountId, 80),
        notes: "PAGO EM LOTE PELO FLUXO DE CAIXA",
      });
      if ("error" in plan) { skip(plan.error); continue; }
      statements.push(...plan.statements);
    }

    if (statements.length) await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied: payables.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar a ação em lote nas contas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
