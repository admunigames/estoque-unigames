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
import { planRuleLearning } from "../shared";
import { loadPayable, planPayablePayment } from "../../payables/shared";

// PATCH de um lançamento do extrato: classificar (categoria/subcategoria/
// unidade/centro de custo/DRE/rateio/ATIVIDADE), confirmar, vincular a uma
// Despesa ou BAIXAR uma conta a pagar ({ payPayableId }: registra o
// pagamento na conta a pagar com a conta e a data deste lançamento e confirma
// o lançamento — 23/10/2026).
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
  status: string;
  activityId: string;
  payableId: string;
  entryDate: string;
  amountCents: number;
  description: string;
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
                expense_id AS expenseId, status, activity_id AS activityId, payable_id AS payableId,
                entry_date AS entryDate, amount_cents AS amountCents, description
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

    // Depósito de crediário (Financeiro 7/9) só sai pelo crediário.
    if (entry.status === "credit_sale") {
      return jsonResponse({ error: "ENTRADA VINCULADA A CREDIÁRIO. VOLTE O CREDIÁRIO PARA PENDENTE ANTES." }, 409);
    }

    const body = (await request.json()) as JsonMap;
    const who = actor.displayName || "Administrador";

    // Vincular a uma Despesa já criada pelo endpoint /expenses.
    const expenseId = safeText(body.expenseId, 80);
    if (expenseId) {
      await database
        .prepare(
          `UPDATE finance_bank_statement_entries
           SET expense_id=?1, status='expensed', updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
           WHERE id=?4`,
        )
        .bind(expenseId, actor.id, who, entryId)
        .run();
      return jsonResponse({ updated: true, id: entryId, status: "expensed" });
    }

    // Baixa de conta a pagar sugerida (mesmo valor) a partir desta saída.
    const payPayableId = safeText(body.payPayableId, 80);
    if (payPayableId) {
      if (Number(entry.amountCents) >= 0) return jsonResponse({ error: "SÓ SAÍDAS DO EXTRATO BAIXAM CONTAS A PAGAR." }, 400);
      if (entry.payableId || entry.expenseId || entry.status === "confirmed") {
        return jsonResponse({ error: "ESTE LANÇAMENTO JÁ FOI CONCILIADO." }, 409);
      }
      const payable = await loadPayable(database, payPayableId);
      if (!payable) return jsonResponse({ error: "CONTA A PAGAR NÃO ENCONTRADA." }, 404);
      const plan = await planPayablePayment(database, payable, actor, {
        idempotencyKey: `bank-entry:${entry.id}`,
        amountCents: -Number(entry.amountCents),
        paymentDate: entry.entryDate,
        scheduled: false,
        paymentMethod: "EXTRATO",
        financeAccountId: entry.financeAccountId,
        notes: `BAIXADO PELA CONCILIAÇÃO BANCÁRIA: ${entry.description || "SEM HISTÓRICO"}`.slice(0, 500),
      });
      if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
      await database.batch([
        ...plan.statements.map(([sql, values]) => database.prepare(sql).bind(...values)),
        database
          .prepare(
            `UPDATE finance_bank_statement_entries
             SET payable_id=?1, status='confirmed', category_item_id=?2,
                 updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
             WHERE id=?5`,
          )
          .bind(payable.id, entry.categoryItemId || payable.financeItemId || "", actor.id, who, entryId),
      ]);
      return jsonResponse({ updated: true, id: entryId, status: "confirmed", payableId: payable.id });
    }

    const activityId = body.activityId === undefined ? entry.activityId : safeText(body.activityId, 80);
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
             in_dre=?5, in_rateio=?6, status=?7, updated_by=?8, updated_by_name=?9, updated_at=CURRENT_TIMESTAMP,
             activity_id=?11
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
        activityId,
      )
      .run();

    // Aprendizado: só ao confirmar, e só quando há um nome de
    // estabelecimento para casar (mesma função do lote).
    if (confirm) {
      const learning = await planRuleLearning(
        database,
        companyId,
        entry.rawMerchant,
        { categoryItemId, subcategory, costCenterId, inDre, inRateio },
        { id: actor.id, name: who },
      );
      for (const [sql, values] of learning) await database.prepare(sql).bind(...values).run();
    }

    return jsonResponse({ updated: true, id: entryId, status });
  } catch (error) {
    console.error("Não foi possível atualizar o lançamento do extrato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O LANÇAMENTO." }, 500);
  }
}
