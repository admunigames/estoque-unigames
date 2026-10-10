import type { Database, Statement } from "../card-fees/shared";
import { planExpense } from "../expenses/shared";

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
