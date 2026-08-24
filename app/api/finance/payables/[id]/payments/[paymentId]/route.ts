import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { computeStoredStatus } from "../../../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../../shared";
import { assertAccess, loadPayable } from "../../../shared";

type PaymentRow = {
  id: string;
  payableId: string;
  amountCents: number;
  scheduled: number;
  confirmedAt: string;
};

async function loadPayment(database: Awaited<ReturnType<typeof getD1>>, payableId: string, paymentId: string) {
  return database
    .prepare(
      `SELECT id, payable_id AS payableId, amount_cents AS amountCents, scheduled, confirmed_at AS confirmedAt
       FROM accounts_payable_payments WHERE id=?1 AND payable_id=?2`,
    )
    .bind(paymentId, payableId)
    .first<PaymentRow>();
}

// Confirma um agendamento pendente: só então ele passa a contar no saldo
// pago da obrigação (agendamento sozinho nunca conta, por requisito).
export async function PATCH(request: Request, context: { params: Promise<{ id: string; paymentId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONFIRMAR PAGAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id, paymentId } = await context.params;

  try {
    const body = (await request.json()) as JsonMap;
    if (safeText(body.action, 20) !== "confirm") {
      return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    }

    const database = await getD1();
    const payable = await loadPayable(database, id);
    if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const payment = await loadPayment(database, id, paymentId);
    if (!payment) return jsonResponse({ error: "PAGAMENTO NÃO ENCONTRADO." }, 404);
    if (!payment.scheduled) return jsonResponse({ error: "ESTE PAGAMENTO JÁ NÃO É UM AGENDAMENTO." }, 409);
    if (payment.confirmedAt) {
      return jsonResponse({ confirmed: true, alreadyProcessed: true, id: paymentId });
    }

    const remainingBalance = payable.originalAmountCents - payable.paidAmountCents;
    if (payment.amountCents > remainingBalance) {
      return jsonResponse(
        { error: "O SALDO DA CONTA MUDOU E JÁ NÃO COMPORTA MAIS ESTE VALOR AGENDADO. AJUSTE O VALOR ANTES DE CONFIRMAR." },
        409,
      );
    }

    const actorName = actor.displayName || "Administrador";
    const newPaidAmount = payable.paidAmountCents + payment.amountCents;
    const status = computeStoredStatus({
      originalAmountCents: payable.originalAmountCents,
      paidAmountCents: newPaidAmount,
      canceled: false,
      hasPendingSchedule: false,
    });

    const prepared = [
      database
        .prepare("UPDATE accounts_payable_payments SET confirmed_at=CURRENT_TIMESTAMP WHERE id=?1")
        .bind(paymentId),
      database
        .prepare(
          `UPDATE accounts_payable
           SET paid_amount_cents=?1, status=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
           WHERE id=?5`,
        )
        .bind(newPaidAmount, status, actor.id, actorName, id),
    ];
    await database.batch(prepared);

    return jsonResponse({ confirmed: true, id: paymentId });
  } catch (error) {
    console.error("Não foi possível confirmar o pagamento agendado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONFIRMAR O PAGAMENTO AGENDADO." }, 500);
  }
}

// Cancela um agendamento AINDA NÃO confirmado (não afeta saldo, já que
// agendamento sozinho nunca contava). Pagamento já confirmado não pode ser
// removido por aqui — não existe "excluir pagamento" no requisito, só
// cancelar a conta inteira.
export async function DELETE(request: Request, context: { params: Promise<{ id: string; paymentId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CANCELAR AGENDAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id, paymentId } = await context.params;

  try {
    const database = await getD1();
    const payable = await loadPayable(database, id);
    if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const payment = await loadPayment(database, id, paymentId);
    if (!payment) return jsonResponse({ deleted: true, alreadyProcessed: true });
    if (!payment.scheduled || payment.confirmedAt) {
      return jsonResponse({ error: "SÓ É POSSÍVEL CANCELAR UM AGENDAMENTO AINDA NÃO CONFIRMADO." }, 409);
    }

    const actorName = actor.displayName || "Administrador";
    const remainingScheduled = await database
      .prepare(
        "SELECT COUNT(*) AS total FROM accounts_payable_payments WHERE payable_id=?1 AND scheduled=1 AND confirmed_at='' AND id != ?2",
      )
      .bind(id, paymentId)
      .first<{ total: number }>();

    const prepared = [
      database.prepare("DELETE FROM accounts_payable_payments WHERE id=?1").bind(paymentId),
    ];
    if (payable.status === "scheduled" && Number(remainingScheduled?.total ?? 0) === 0) {
      const status = computeStoredStatus({
        originalAmountCents: payable.originalAmountCents,
        paidAmountCents: payable.paidAmountCents,
        canceled: false,
        hasPendingSchedule: false,
      });
      prepared.push(
        database
          .prepare(
            `UPDATE accounts_payable
             SET status=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
             WHERE id=?4`,
          )
          .bind(status, actor.id, actorName, id),
      );
    }
    await database.batch(prepared);

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível cancelar o agendamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CANCELAR O AGENDAMENTO." }, 500);
  }
}
