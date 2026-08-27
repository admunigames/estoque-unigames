import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../../lib/access-scope";
import { computeCardSummary, type CardEntryForSummary } from "../../../../../lib/corporate-cards";
import { todayInTimezone } from "../../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText } from "../../../shared";

// Painel do cartão: limite, utilizado, disponível, próxima fatura e
// parcelamentos futuros. O cálculo em si é puro
// (app/lib/corporate-cards.ts#computeCardSummary).

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
  const cardId = safeText(id, 80);

  try {
    const database = await getD1();
    const card = await database
      .prepare(
        `SELECT company_id AS companyId, limit_cents AS limitCents,
                closing_day AS closingDay, due_day AS dueDay
         FROM finance_corporate_cards WHERE id=?1`,
      )
      .bind(cardId)
      .first<{ companyId: string; limitCents: number; closingDay: number; dueDay: number }>();
    if (!card) return jsonResponse({ error: "CARTÃO NÃO ENCONTRADO." }, 404);

    const scopeActor = scopeActorOf(request, actor);
    const allStores = canSeeAllStores(scopeActor, "finance:manage");
    if (!allStores && !hasCompany(scopeActor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    if (!allStores && card.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESTE CARTÃO." }, 403);
    }

    const rows = await database
      .prepare(
        `SELECT entry_date AS entryDate, amount_cents AS amountCents,
                installment_current AS installmentCurrent, installment_total AS installmentTotal
         FROM finance_card_invoice_entries WHERE card_id=?1`,
      )
      .bind(cardId)
      .all<CardEntryForSummary>();

    const summary = computeCardSummary({
      limitCents: Number(card.limitCents || 0),
      closingDay: Number(card.closingDay || 1),
      dueDay: Number(card.dueDay || 10),
      today: todayInTimezone(),
      entries: (rows.results ?? []).map((row) => ({
        entryDate: row.entryDate,
        amountCents: Number(row.amountCents || 0),
        installmentCurrent: Number(row.installmentCurrent || 1),
        installmentTotal: Number(row.installmentTotal || 1),
      })),
    });
    return jsonResponse({ summary });
  } catch (error) {
    console.error("Não foi possível carregar o resumo do cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RESUMO DO CARTÃO." }, 500);
  }
}
