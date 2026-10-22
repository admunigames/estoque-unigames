import type { Database, Statement } from "../card-fees/shared";
import { planExpense } from "../expenses/shared";
import { safeText, type JsonMap } from "../shared";
import { nextRechargeDate as computeNextRecharge, parseRechargePeriod, RECHARGE_PERIOD_ERROR } from "../../../lib/phone-recharges";

// Recarga registrada → Despesa do mês (EM ABERTO, vencimento = data da
// recarga, na unidade da linha), pelo mesmo planExpense de Despesas — conta a
// pagar e DRE iguais a uma despesa lançada à mão. Usado pelo REGISTRAR
// RECARGA ([id]/recharge) e pelo lote (bulk, action 'recharge').

export type RechargeLine = { id: string; phoneNumber: string; carrier: string; companyId: string; companyName: string };

export async function planRechargeExpense(
  database: Database,
  actor: { id: string; displayName: string },
  line: RechargeLine,
  input: { eventId: string; rechargeDate: string; amountCents: number; financeItemId: string },
): Promise<{ error: string; status: number } | { expenseId: string; statements: Statement[] }> {
  if (!input.financeItemId) return { error: "ESCOLHA A CATEGORIA DA DESPESA DA RECARGA.", status: 400 };
  if (!line.companyId) return { error: "A LINHA ESTÁ SEM UNIDADE — EDITE A LINHA E ESCOLHA A UNIDADE.", status: 400 };
  const plan = await planExpense(database, actor, { allStores: true, companyId: "" }, {
    idempotencyKey: `recarga:${input.eventId}`,
    kind: "single",
    companyId: line.companyId,
    companyName: line.companyName,
    description: `RECARGA ${line.phoneNumber}${line.carrier ? ` (${line.carrier})` : ""}`.slice(0, 200),
    financeItemId: input.financeItemId,
    originalAmountCents: input.amountCents,
    issueDate: input.rechargeDate,
    dueDate: input.rechargeDate,
    rateioType: "single_store",
    notes: "LANÇADA PELO REGISTRAR RECARGA (RECARGAS DE CELULARES).",
  });
  if ("reply" in plan) return { error: String(plan.reply.payload.error ?? "NÃO FOI POSSÍVEL LANÇAR A DESPESA DA RECARGA."), status: plan.reply.status };
  return { expenseId: plan.expenseId, statements: plan.statements };
}

export type RechargeLineInput = {
  phoneNumber: string;
  carrier: string;
  companyId: string;
  companyName: string;
  responsibleName: string;
  notes: string;
  active: number;
  lastRechargeDate: string;
  lastAmountCents: number;
  periodDays: number;
  nextRechargeDate: string;
};

/**
 * Valida UMA linha de recarga (cadastro ou edição) — usada pelo POST e pelo
 * CADASTRAR EM LOTE (phone-recharges/batch).
 */
export function validateRechargeLine(body: JsonMap): { error: string } | { input: RechargeLineInput } {
  const phoneNumber = safeText(body.phoneNumber, 40);
  if (phoneNumber.length < 8) return { error: "INFORME O NÚMERO DO CELULAR." };
  const carrier = safeText(body.carrier, 60);
  if (!carrier) return { error: "INFORME A OPERADORA." };
  const companyId = safeText(body.companyId, 80);
  const companyName = safeText(body.companyName, 160);
  if (!companyId) return { error: "SELECIONE A UNIDADE." };
  const responsibleName = safeText(body.responsibleName, 160);
  const notes = safeText(body.notes, 2000);
  const active = body.active === false ? 0 : 1;
  const lastRechargeDate = safeText(body.lastRechargeDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastRechargeDate)) return { error: "INFORME A DATA DA ÚLTIMA RECARGA." };
  const lastAmountCents = Number(body.lastAmountCents);
  if (!Number.isInteger(lastAmountCents) || lastAmountCents < 0) return { error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." };
  const periodDays = parseRechargePeriod(body.periodDays);
  if (!periodDays) return { error: RECHARGE_PERIOD_ERROR };
  return {
    input: {
      phoneNumber, carrier, companyId, companyName, responsibleName, notes, active, lastRechargeDate, lastAmountCents,
      periodDays, nextRechargeDate: computeNextRecharge(lastRechargeDate, periodDays),
    },
  };
}

export function insertRechargeLineSql(id: string, input: RechargeLineInput, actor: { id: string; displayName: string }): [string, unknown[]] {
  const who = actor.displayName || "Administrador";
  return [
    `INSERT INTO finance_phone_recharges
      (id, phone_number, carrier, company_id, company_name, responsible_name,
       last_amount_cents, last_recharge_date, next_recharge_date, notes, active,
       created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, period_days)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,CURRENT_TIMESTAMP,?12,?13,CURRENT_TIMESTAMP,?14)`,
    [
      id, input.phoneNumber, input.carrier, input.companyId, input.companyName, input.responsibleName, input.lastAmountCents,
      input.lastRechargeDate, input.nextRechargeDate, input.notes, input.active, actor.id, who, input.periodDays,
    ],
  ];
}
