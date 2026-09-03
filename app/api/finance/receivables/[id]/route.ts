import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { todayInTimezone } from "../../../../lib/finance-status";
import { DATE_PATTERN } from "../../../../lib/payables-recurrence";
import {
  computeReceivableDisplayStatus,
  expectedDateFromCompetence,
  receivableDifferenceCents,
  toleranceFromSettings,
} from "../../../../lib/receivables-status";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../shared";
import { loadEffectiveCashFlowSettings } from "../../cash-flow-settings/shared";
import {
  assertReceivableAccess,
  loadReceivable,
  parseReceived,
  resolveReceivableOperator,
} from "../shared";

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

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
    const row = await loadReceivable(database, id);
    if (!row) return jsonResponse({ error: "RECEBÍVEL NÃO ENCONTRADO." }, 404);
    const accessError = assertReceivableAccess(scopeActorOf(request, actor), row);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const settings = await loadEffectiveCashFlowSettings(database, row.companyId);
    const today = todayInTimezone();
    return jsonResponse({
      receivable: {
        ...row,
        differenceCents: receivableDifferenceCents(row.expectedAmountCents, row.receivedAmountCents),
        displayStatus: computeReceivableDisplayStatus({
          canceled: Number(row.canceled) === 1,
          expectedDate: row.expectedDate,
          expectedAmountCents: row.expectedAmountCents,
          receivedAmountCents: row.receivedAmountCents,
          tolerance: toleranceFromSettings(settings),
          today,
        }),
      },
      settings,
      today,
    });
  } catch (error) {
    console.error("Não foi possível carregar o recebível.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RECEBÍVEL." }, 500);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR RECEBÍVEIS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const existing = await loadReceivable(database, id);
    if (!existing) return jsonResponse({ error: "RECEBÍVEL NÃO ENCONTRADO." }, 404);
    const scopeActor = scopeActorOf(request, actor);
    const accessError = assertReceivableAccess(scopeActor, existing);
    if (accessError) return jsonResponse({ error: accessError }, 403);
    if (Number(existing.canceled) === 1) {
      return jsonResponse({ error: "ESTE RECEBÍVEL ESTÁ CANCELADO E NÃO PODE SER EDITADO." }, 409);
    }

    const body = (await request.json()) as JsonMap;
    // A unidade de um recebível não muda por edição: trocar de loja mudaria o
    // escopo de quem enxerga o registro e o caixa de qual unidade ele afeta.
    // Se for o caso, cancela-se o recebível e cria-se outro — decisão tomada
    // aqui sem confirmação prévia (ver descrição do PR da Fase 6).
    const competenceMonth = safeText(body.competenceMonth, 7);
    const notes = safeText(body.notes, 500);
    const expectedAmountCents = Math.round(Number(body.amountCents ?? body.expectedAmountCents));

    const operator = await resolveReceivableOperator(database, body, existing.companyId);
    if (operator.error) return jsonResponse({ error: operator.error }, 400);
    const { operatorText } = operator;
    if (!MONTH_PATTERN.test(competenceMonth)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }
    // Data prevista não é mais editável no cadastro simplificado (item 4):
    // usa a que veio (compatibilidade), senão mantém a atual, senão deriva
    // da competência.
    const requestedExpectedDate = safeText(body.expectedDate, 10);
    const expectedDate = DATE_PATTERN.test(requestedExpectedDate)
      ? requestedExpectedDate
      : DATE_PATTERN.test(existing.expectedDate)
        ? existing.expectedDate
        : expectedDateFromCompetence(competenceMonth);
    if (!Number.isFinite(expectedAmountCents) || expectedAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR MAIOR QUE ZERO." }, 400);
    }

    const received = parseReceived(body);
    if (received.error) return jsonResponse({ error: received.error }, 400);

    // O nome da loja é re-resolvido do cadastro a cada escrita (o registro
    // guarda uma cópia só pra exibição, como em accounts_payable).
    const companies = await loadCompanyList(database);
    const companyName = companies.find((item) => item.id === existing.companyId)?.name ?? existing.companyName;

    await database
      .prepare(
        `UPDATE accounts_receivable
         SET company_name=?1, operator_text=?2, acquirer_id=?3, competence_month=?4, expected_date=?5,
             expected_amount_cents=?6, received_amount_cents=?7, received_date=?8, notes=?9,
             updated_by=?10, updated_by_name=?11, updated_at=CURRENT_TIMESTAMP
         WHERE id=?12`,
      )
      .bind(
        companyName,
        operatorText,
        operator.acquirerId,
        competenceMonth,
        expectedDate,
        expectedAmountCents,
        received.receivedAmountCents,
        received.receivedDate,
        notes,
        actor.id,
        actor.displayName || "Administrador",
        id,
      )
      .run();

    return jsonResponse({ updated: true, id });
  } catch (error) {
    console.error("Não foi possível editar o recebível.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O RECEBÍVEL." }, 500);
  }
}
