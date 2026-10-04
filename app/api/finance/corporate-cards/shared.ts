import { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import type { CardEntryFields } from "../../../lib/corporate-cards";
import { identity, jsonResponse, safeText, type JsonMap } from "../shared";

// Partes comuns das rotas de fatura dos Cartões Corporativos (lançamentos,
// ações em lote e gastos por categoria).

type Actor = ReturnType<typeof identity>;

export function scopeActorOf(request: Request, actor: Actor) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

/** Cartão existe e o login pode mexer nele (escopo por loja). */
export async function assertCardAccess(request: Request, actor: Actor, cardId: string) {
  const database = await getD1();
  const card = await database
    .prepare("SELECT id, name, company_id AS companyId, company_name AS companyName FROM finance_corporate_cards WHERE id=?1")
    .bind(cardId)
    .first<{ id: string; name: string; companyId: string; companyName: string }>();
  if (!card) return { error: jsonResponse({ error: "CARTÃO NÃO ENCONTRADO." }, 404) };
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  }
  if (!allStores && card.companyId !== scopeActor.companyId) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESTE CARTÃO." }, 403) };
  }
  return { database, card, allStores, scopeCompanyId: scopeActor.companyId };
}

/** Só os campos PRESENTES no corpo entram (o resto fica como está). */
export function parseCardEntryFields(input: unknown): CardEntryFields {
  const body = (input && typeof input === "object" ? input : {}) as JsonMap;
  const fields: CardEntryFields = {};
  if (body.categoryItemId !== undefined) fields.categoryItemId = safeText(body.categoryItemId, 80);
  if (body.costCenterId !== undefined) fields.costCenterId = safeText(body.costCenterId, 80);
  if (body.holderName !== undefined) fields.holderName = safeText(body.holderName, 120);
  if (body.notes !== undefined) fields.notes = safeText(body.notes, 1000);
  if (body.expenseKind === "expense" || body.expenseKind === "not_expense") fields.expenseKind = body.expenseKind;
  return fields;
}

export type StoredCardEntry = {
  id: string;
  entryDate: string;
  merchant: string;
  amountCents: number;
  installmentLabel: string;
  categoryItemId: string;
  costCenterId: string;
  holderName: string;
  notes: string;
  expenseId: string;
  status: string;
};

export const ENTRY_COLUMNS = `id, entry_date AS entryDate, merchant, amount_cents AS amountCents,
  installment_label AS installmentLabel, installment_current AS installmentCurrent,
  installment_total AS installmentTotal, category_item_id AS categoryItemId,
  cost_center_id AS costCenterId, holder_name AS holderName, notes,
  expense_id AS expenseId, status`;
