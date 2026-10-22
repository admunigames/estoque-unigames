import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { nextRechargeDate as computeNextRecharge, parseRechargePeriod } from "../../../../lib/phone-recharges";
import { competenceMonthOf, recalcPayableEntrySql } from "../../../../lib/payables-recurrence";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";

// EDITAR / EXCLUIR uma recarga do HISTÓRICO (Recargas de Celulares, 22/10/2026):
// - PATCH ?id=: data, valor e categoria. Atualiza a despesa gerada e a conta a
//   pagar dela (DRE recalculada). Se a conta já foi PAGA (ou tem pagamento),
//   só a categoria muda — data e valor ficam bloqueados.
// - DELETE ?id=: tira a recarga do histórico com a despesa e a conta a pagar
//   (se nada foi pago).
// Se a recarga mexida era a última da linha, a última/próxima recarga da linha
// é recalculada pela recarga mais recente que sobrar.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type EventRow = { id: string; rechargeId: string; rechargeDate: string; amountCents: number; expenseId: string };
type PayableRow = { id: string; companyId: string; financeItemId: string; competenceMonth: string; paidAmountCents: number; status: string };

async function loadContext(database: Awaited<ReturnType<typeof getD1>>, id: string) {
  const event = await database
    .prepare(
      `SELECT id, recharge_id AS rechargeId, recharge_date AS rechargeDate, amount_cents AS amountCents, expense_id AS expenseId
       FROM finance_phone_recharge_events WHERE id=?1`,
    )
    .bind(id)
    .first<EventRow>();
  if (!event) return null;
  const payables = event.expenseId
    ? ((
        await database
          .prepare(
            `SELECT id, company_id AS companyId, finance_item_id AS financeItemId, competence_month AS competenceMonth,
                    paid_amount_cents AS paidAmountCents, status
             FROM accounts_payable WHERE expense_id=?1`,
          )
          .bind(event.expenseId)
          .all<PayableRow>()
      ).results ?? [])
    : [];
  const confirmed = payables.length
    ? await database
        .prepare(
          `SELECT COUNT(*) AS n FROM accounts_payable_payments
           WHERE confirmed_at <> '' AND payable_id IN (${payables.map((_, index) => `?${index + 1}`).join(",")})`,
        )
        .bind(...payables.map((row) => row.id))
        .first<{ n: number }>()
    : { n: 0 };
  const paid = payables.some((row) => row.status === "paid" || Number(row.paidAmountCents) > 0) || Number(confirmed?.n || 0) > 0;
  return { event, payables, paid };
}

// Última/próxima recarga da linha pela recarga mais recente que sobrou.
async function refreshLineStatements(
  database: Awaited<ReturnType<typeof getD1>>,
  rechargeId: string,
  override: { id: string; rechargeDate: string; amountCents: number } | { deletedId: string },
  actor: { id: string; name: string },
): Promise<[string, unknown[]][]> {
  const line = await database
    .prepare("SELECT period_days AS periodDays FROM finance_phone_recharges WHERE id=?1")
    .bind(rechargeId)
    .first<{ periodDays: number }>();
  if (!line) return [];
  const rows = (
    await database
      .prepare(
        `SELECT id, recharge_date AS rechargeDate, amount_cents AS amountCents, created_at AS createdAt
         FROM finance_phone_recharge_events WHERE recharge_id=?1`,
      )
      .bind(rechargeId)
      .all<{ id: string; rechargeDate: string; amountCents: number; createdAt: string }>()
  ).results ?? [];
  const current = rows
    .filter((row) => !("deletedId" in override) || row.id !== override.deletedId)
    .map((row) => ("id" in override && row.id === override.id ? { ...row, ...override } : row))
    .sort((a, b) => b.rechargeDate.localeCompare(a.rechargeDate) || b.createdAt.localeCompare(a.createdAt));
  const latest = current[0];
  if (!latest) return [];
  const next = computeNextRecharge(latest.rechargeDate, parseRechargePeriod(line.periodDays) ?? 90);
  return [[
    `UPDATE finance_phone_recharges
     SET last_recharge_date=?1, last_amount_cents=?2, next_recharge_date=?3,
         updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
     WHERE id=?6`,
    [latest.rechargeDate, latest.amountCents, next, actor.id, actor.name, rechargeId],
  ]];
}

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { response: unauthorized };
  const actor = identity(request);
  if (!canManageFinance(actor)) return { response: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR RECARGAS." }, 403) };
  if (!sameOrigin(request)) return { response: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

export async function PATCH(request: Request) {
  const checked = guard(request);
  if ("response" in checked) return checked.response;
  const actor = checked.actor;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  try {
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const context = await loadContext(database, id);
    if (!context) return jsonResponse({ error: "RECARGA NÃO ENCONTRADA NO HISTÓRICO." }, 404);
    const { event, payables, paid } = context;

    const rechargeDate = body.rechargeDate === undefined ? event.rechargeDate : safeText(body.rechargeDate, 10);
    if (!DATE_PATTERN.test(rechargeDate)) return jsonResponse({ error: "INFORME A DATA DA RECARGA." }, 400);
    const amountCents = body.amountCents === undefined ? Number(event.amountCents) : Number(body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    const financeItemId = safeText(body.financeItemId, 80);
    if (paid && (rechargeDate !== event.rechargeDate || amountCents !== Number(event.amountCents))) {
      return jsonResponse({ error: "A DESPESA DESTA RECARGA JÁ FOI PAGA — SÓ A CATEGORIA PODE SER ALTERADA." }, 409);
    }
    if (financeItemId) {
      const item = await database.prepare("SELECT id FROM finance_items WHERE id=?1").bind(financeItemId).first();
      if (!item) return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA NO CATÁLOGO FINANCEIRO." }, 400);
    }

    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const month = competenceMonthOf(rechargeDate);
    // Conta já paga: só a categoria muda (valor/data ficam como estavam).
    const statements: [string, unknown[]][] = paid
      ? []
      : [["UPDATE finance_phone_recharge_events SET recharge_date=?1, amount_cents=?2 WHERE id=?3", [rechargeDate, amountCents, id]]];
    const slots = new Map<string, [string, string, string]>();
    if (event.expenseId) {
      statements.push(
        paid
          ? [
              `UPDATE expenses SET finance_item_id=COALESCE(NULLIF(?1, ''), finance_item_id),
                 updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
              [financeItemId, who.id, who.name, event.expenseId],
            ]
          : [
              `UPDATE expenses SET original_amount_cents=?1, issue_date=?2, due_date=?2, competence_month=?3,
                 finance_item_id=COALESCE(NULLIF(?4, ''), finance_item_id),
                 updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP WHERE id=?7`,
              [amountCents, rechargeDate, month, financeItemId, who.id, who.name, event.expenseId],
            ],
      );
      for (const payable of payables) {
        if (payable.status === "canceled") continue;
        const nextItem = financeItemId || payable.financeItemId;
        const nextMonth = paid ? payable.competenceMonth : month;
        slots.set(`${payable.companyId}|${payable.financeItemId}|${payable.competenceMonth}`, [payable.companyId, payable.financeItemId, payable.competenceMonth]);
        slots.set(`${payable.companyId}|${nextItem}|${nextMonth}`, [payable.companyId, nextItem, nextMonth]);
        statements.push(
          paid
            ? [
                `UPDATE accounts_payable SET finance_item_id=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
                [nextItem, who.id, who.name, payable.id],
              ]
            : [
                `UPDATE accounts_payable SET original_amount_cents=?1, issue_date=?2, due_date=?2, competence_month=?3, finance_item_id=?4,
                   updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP WHERE id=?7`,
                [amountCents, rechargeDate, month, nextItem, who.id, who.name, payable.id],
              ],
        );
      }
    }
    for (const [companyId, itemId, slotMonth] of slots.values()) {
      statements.push(...recalcPayableEntrySql(crypto.randomUUID(), companyId, itemId, slotMonth, who.id, who.name));
    }
    if (!paid && rechargeDate !== event.rechargeDate) {
      statements.push(...(await refreshLineStatements(database, event.rechargeId, { id, rechargeDate, amountCents }, who)));
    }
    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ updated: true, id, onlyCategory: paid });
  } catch (error) {
    console.error("Não foi possível editar a recarga.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A RECARGA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request);
  if ("response" in checked) return checked.response;
  const actor = checked.actor;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  try {
    const database = await getD1();
    const context = await loadContext(database, id);
    if (!context) return jsonResponse({ error: "RECARGA NÃO ENCONTRADA NO HISTÓRICO." }, 404);
    const { event, payables, paid } = context;
    if (paid) return jsonResponse({ error: "A DESPESA DESTA RECARGA JÁ FOI PAGA — NÃO PODE SER EXCLUÍDA." }, 409);
    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const statements: [string, unknown[]][] = [["DELETE FROM finance_phone_recharge_events WHERE id=?1", [id]]];
    for (const payable of payables) {
      statements.push(
        ["DELETE FROM accounts_payable_payments WHERE payable_id=?1", [payable.id]],
        ["DELETE FROM accounts_payable WHERE id=?1", [payable.id]],
      );
    }
    if (event.expenseId) {
      statements.push(
        ["DELETE FROM expense_rateio_shares WHERE expense_id=?1", [event.expenseId]],
        ["DELETE FROM expense_attachments WHERE expense_id=?1", [event.expenseId]],
        ["DELETE FROM expenses WHERE id=?1", [event.expenseId]],
      );
    }
    for (const payable of payables) {
      statements.push(...recalcPayableEntrySql(crypto.randomUUID(), payable.companyId, payable.financeItemId, payable.competenceMonth, who.id, who.name));
    }
    statements.push(...(await refreshLineStatements(database, event.rechargeId, { deletedId: id }, who)));
    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir a recarga.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A RECARGA." }, 500);
  }
}
