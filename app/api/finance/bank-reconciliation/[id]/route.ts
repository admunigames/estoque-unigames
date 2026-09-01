import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../shared";

// PATCH de um lançamento do extrato: classificar (categoria/subcategoria/
// unidade/centro de custo/DRE/rateio), confirmar ou vincular a uma Despesa.
// Ao CONFIRMAR, faz upsert da regra de aprendizado por nome do
// estabelecimento (finance_bank_classification_rules).

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

type EntryRow = {
  id: string;
  financeAccountId: string;
  companyId: string;
  rawMerchant: string;
  categoryItemId: string;
  subcategory: string;
  costCenterId: string;
  inDre: number;
  inRateio: number;
  expenseId: string;
};

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR A CONCILIAÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const entryId = safeText(id, 80);

  try {
    const database = await getD1();
    const entry = await database
      .prepare(
        `SELECT id, finance_account_id AS financeAccountId, company_id AS companyId,
                raw_merchant AS rawMerchant, category_item_id AS categoryItemId, subcategory,
                cost_center_id AS costCenterId, in_dre AS inDre, in_rateio AS inRateio,
                expense_id AS expenseId
         FROM finance_bank_statement_entries WHERE id=?1`,
      )
      .bind(entryId)
      .first<EntryRow>();
    if (!entry) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);

    const scopeActor = scopeActorOf(request, actor);
    const allStores = canSeeAllStores(scopeActor, "finance:manage");
    if (!allStores && !hasCompany(scopeActor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    if (!allStores && entry.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSE LANÇAMENTO." }, 403);
    }

    const body = (await request.json()) as JsonMap;
    const who = actor.displayName || "Administrador";

    // Vincular a uma Despesa já criada pelo endpoint /expenses.
    const expenseId = safeText(body.expenseId, 80);
    if (expenseId) {
      await database
        .prepare(
          `UPDATE finance_bank_statement_entries
           SET expense_id=?1, status='expensed', updated_by=?2, updated_by_name=?3, updated_at=now()::text
           WHERE id=?4`,
        )
        .bind(expenseId, actor.id, who, entryId)
        .run();
      return jsonResponse({ updated: true, id: entryId, status: "expensed" });
    }

    const categoryItemId = safeText(body.categoryItemId, 80);
    const subcategory = safeText(body.subcategory, 120);
    const costCenterId = safeText(body.costCenterId, 80);
    const inDre = body.inDre === false || body.inDre === 0 ? 0 : 1;
    const inRateio = body.inRateio === true || body.inRateio === 1 ? 1 : 0;
    const confirm = body.confirm === true;
    let companyId = entry.companyId;
    const requestedCompanyId = safeText(body.companyId, 80);
    if (requestedCompanyId && hasCompany(requestedCompanyId)) {
      if (!allStores && requestedCompanyId !== scopeActor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO PODE MOVER PARA ESSA LOJA." }, 403);
      }
      companyId = requestedCompanyId;
    }

    if (confirm && !categoryItemId) {
      return jsonResponse({ error: "ESCOLHA A CATEGORIA ANTES DE CONFIRMAR." }, 400);
    }
    const status = confirm ? "confirmed" : categoryItemId ? "classified" : "pending";

    await database
      .prepare(
        `UPDATE finance_bank_statement_entries
         SET category_item_id=?1, subcategory=?2, cost_center_id=?3, company_id=?4,
             in_dre=?5, in_rateio=?6, status=?7, updated_by=?8, updated_by_name=?9, updated_at=now()::text
         WHERE id=?10`,
      )
      .bind(
        categoryItemId,
        subcategory,
        costCenterId,
        companyId,
        inDre,
        inRateio,
        status,
        actor.id,
        who,
        entryId,
      )
      .run();

    // Aprendizado: só ao confirmar, e só quando há um nome de
    // estabelecimento para casar.
    if (confirm && entry.rawMerchant) {
      const existing = await database
        .prepare(
          "SELECT id, hits FROM finance_bank_classification_rules WHERE company_id=?1 AND merchant_key=?2",
        )
        .bind(companyId, entry.rawMerchant)
        .first<{ id: string; hits: number }>();
      if (existing) {
        await database
          .prepare(
            `UPDATE finance_bank_classification_rules
             SET category_item_id=?1, subcategory=?2, cost_center_id=?3, in_dre=?4, in_rateio=?5,
                 hits=?6, updated_by=?7, updated_by_name=?8, updated_at=now()::text
             WHERE id=?9`,
          )
          .bind(
            categoryItemId,
            subcategory,
            costCenterId,
            inDre,
            inRateio,
            Number(existing.hits || 0) + 1,
            actor.id,
            who,
            existing.id,
          )
          .run();
      } else {
        await database
          .prepare(
            `INSERT INTO finance_bank_classification_rules
              (id, company_id, merchant_key, category_item_id, subcategory, cost_center_id,
               in_dre, in_rateio, hits, updated_by, updated_by_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10)`,
          )
          .bind(
            crypto.randomUUID(),
            companyId,
            entry.rawMerchant,
            categoryItemId,
            subcategory,
            costCenterId,
            inDre,
            inRateio,
            actor.id,
            who,
          )
          .run();
      }
    }

    return jsonResponse({ updated: true, id: entryId, status });
  } catch (error) {
    console.error("Não foi possível atualizar o lançamento do extrato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O LANÇAMENTO." }, 500);
  }
}
