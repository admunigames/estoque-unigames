import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../../shared";
import { nextRechargeDate as computeNextRecharge, parseRechargePeriod } from "../../../../../lib/phone-recharges";
import { runStatements } from "../../../card-fees/shared";
import { planRechargeExpense, type RechargeLine } from "../../shared";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Registra uma recarga efetivada: grava um evento no histórico, atualiza
// última/próxima recarga do cadastro (próxima = data + período da linha) e
// lança a Despesa do mês (planRechargeExpense) — tudo numa transação.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR RECARGAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const rechargeId = safeText(id, 80);

  try {
    const body = (await request.json()) as JsonMap;
    const rechargeDate = safeText(body.rechargeDate, 10);
    if (!DATE_PATTERN.test(rechargeDate)) return jsonResponse({ error: "INFORME A DATA DA RECARGA." }, 400);
    const amountCents = Number(body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }
    const notes = safeText(body.notes, 1000);
    const financeItemId = safeText(body.financeItemId, 80);

    const database = await getD1();
    const existing = await database
      .prepare(
        `SELECT id, period_days AS periodDays, phone_number AS phoneNumber, carrier, company_id AS companyId,
                company_name AS companyName
         FROM finance_phone_recharges WHERE id=?1`,
      )
      .bind(rechargeId)
      .first<RechargeLine & { periodDays: number }>();
    if (!existing) return jsonResponse({ error: "RECARGA NÃO ENCONTRADA." }, 404);

    const who = actor.displayName || "Administrador";
    const nextRechargeDate = computeNextRecharge(rechargeDate, parseRechargePeriod(existing.periodDays) ?? 90);
    // A recarga vira Despesa do mês (em aberto, vence na data da recarga).
    const eventId = crypto.randomUUID();
    const expense = await planRechargeExpense(database, actor, existing, { eventId, rechargeDate, amountCents, financeItemId });
    if ("error" in expense) return jsonResponse({ error: expense.error }, expense.status);
    await runStatements(database, [
      [
        `INSERT INTO finance_phone_recharge_events
          (id, recharge_id, recharge_date, amount_cents, notes, created_by, created_by_name, created_at, expense_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP,?8)`,
        [eventId, rechargeId, rechargeDate, amountCents, notes, actor.id, who, expense.expenseId],
      ],
      [
        `UPDATE finance_phone_recharges
         SET last_recharge_date=?1, last_amount_cents=?2, next_recharge_date=?3,
             updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
         WHERE id=?6`,
        [rechargeDate, amountCents, nextRechargeDate, actor.id, who, rechargeId],
      ],
      ...expense.statements,
    ]);
    return jsonResponse({ recorded: true, id: rechargeId, nextRechargeDate, expenseId: expense.expenseId }, 201);
  } catch (error) {
    console.error("Não foi possível registrar a recarga.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A RECARGA." }, 500);
  }
}
