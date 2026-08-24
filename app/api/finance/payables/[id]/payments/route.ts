import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { computeStoredStatus } from "../../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../shared";
import { DATE_PATTERN, assertAccess, assertFinanceAccountBelongsToCompany, loadPayable } from "../../shared";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const { id } = await context.params;

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

    const result = await database
      .prepare(
        `SELECT id, amount_cents AS amountCents, payment_date AS paymentDate, payment_method AS paymentMethod,
                finance_account_id AS financeAccountId, notes, scheduled, confirmed_at AS confirmedAt,
                created_by_name AS createdByName, created_at AS createdAt
         FROM accounts_payable_payments WHERE payable_id=?1 ORDER BY created_at DESC`,
      )
      .bind(id)
      .all();
    return jsonResponse({ payments: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o histórico de pagamentos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O HISTÓRICO DE PAGAMENTOS." }, 500);
  }
}

// Registrar pagamento integral/parcial (scheduled=false, confirmado na
// hora) ou agendar um pagamento futuro (scheduled=true, só entra no saldo
// quando confirmado — ver .../payments/[paymentId]). Regra de competência:
// pagamento NUNCA toca finance_store_entries, só atualiza paid_amount_cents
// e status da obrigação (o lançamento na DRE já foi feito na criação).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR PAGAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const body = (await request.json()) as JsonMap;
    const idempotencyKey = safeText(body.idempotencyKey, 120);
    if (!idempotencyKey) return jsonResponse({ error: "REQUISIÇÃO INVÁLIDA (SEM CHAVE DE IDEMPOTÊNCIA)." }, 400);

    const database = await getD1();
    const payable = await loadPayable(database, id);
    if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);
    if (payable.status === "canceled") {
      return jsonResponse({ error: "ESTA CONTA ESTÁ CANCELADA." }, 409);
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const existingByKey = await database
      .prepare("SELECT id FROM accounts_payable_payments WHERE idempotency_key=?1")
      .bind(idempotencyKey)
      .first<{ id: string }>();
    if (existingByKey) {
      return jsonResponse({ created: true, alreadyProcessed: true, id: existingByKey.id });
    }

    const amountCents = Math.trunc(Number(body.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR DE PAGAMENTO VÁLIDO E POSITIVO." }, 400);
    }

    const paymentDate = safeText(body.paymentDate, 10);
    if (!DATE_PATTERN.test(paymentDate)) return jsonResponse({ error: "INFORME A DATA DO PAGAMENTO." }, 400);

    const scheduled = body.scheduled === true;
    const remainingBalance = payable.originalAmountCents - payable.paidAmountCents;
    if (amountCents > remainingBalance) {
      return jsonResponse(
        { error: "O VALOR DO PAGAMENTO NÃO PODE SER MAIOR QUE O SALDO EM ABERTO DA CONTA." },
        400,
      );
    }

    const paymentMethod = safeText(body.paymentMethod, 40);
    const financeAccountId = safeText(body.financeAccountId, 80);
    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, payable.companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);

    const notes = safeText(body.notes, 2000);
    const paymentId = crypto.randomUUID();
    const actorName = actor.displayName || "Administrador";

    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO accounts_payable_payments
          (id, payable_id, amount_cents, payment_date, payment_method, finance_account_id, notes,
           scheduled, confirmed_at, created_by, created_by_name, created_at, idempotency_key)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,CURRENT_TIMESTAMP,?12)`,
        [
          paymentId,
          id,
          amountCents,
          paymentDate,
          paymentMethod,
          financeAccountId,
          notes,
          scheduled ? 1 : 0,
          scheduled ? "" : new Date().toISOString(),
          actor.id,
          actorName,
          idempotencyKey,
        ],
      ],
    ];

    if (!scheduled) {
      const newPaidAmount = payable.paidAmountCents + amountCents;
      const status = computeStoredStatus({
        originalAmountCents: payable.originalAmountCents,
        paidAmountCents: newPaidAmount,
        canceled: false,
        hasPendingSchedule: false,
      });
      statements.push([
        `UPDATE accounts_payable
         SET paid_amount_cents=?1, status=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
         WHERE id=?5`,
        [newPaidAmount, status, actor.id, actorName, id],
      ]);
    } else if (payable.status === "open") {
      statements.push([
        `UPDATE accounts_payable
         SET status='scheduled', updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, id],
      ]);
    }

    const prepared = statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues));
    await database.batch(prepared);

    return jsonResponse({ created: true, id: paymentId, scheduled }, 201);
  } catch (error) {
    console.error("Não foi possível registrar o pagamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O PAGAMENTO." }, 500);
  }
}
