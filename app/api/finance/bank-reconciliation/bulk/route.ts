import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { planRuleLearning } from "../shared";

// Ações em lote da CONCILIAÇÃO BANCÁRIA (Financeiro 9/9): { action, ids, fields }
// - classify: CLASSIFICAR — só os campos enviados (categoryItemId, subcategory,
//   companyId, costCenterId, inDre, inRateio) são aplicados; fica
//   'classified' com categoria, 'pending' sem (mesmo efeito do individual);
// - confirm: CONFIRMAR — precisa de categoria; alimenta as regras de
//   aprendizado como o CONFIRMAR individual;
// - unclassify: VOLTAR PARA A CLASSIFICAR (mantém a classificação como sugestão).
// Lançamento que virou despesa ou crediário é pulado (sai pela própria tela).
// Excluir não existe na tela individual, então não existe no lote.
// "VIRAR DESPESA" continua individual. Ids conferidos antes (404/403); uma transação.

const ACTIONS = ["classify", "confirm", "unclassify"];

type Entry = {
  id: string;
  companyId: string;
  rawMerchant: string;
  description: string;
  categoryItemId: string;
  subcategory: string;
  costCenterId: string;
  inDre: number;
  inRateio: number;
  status: string;
};

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR A CONCILIAÇÃO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = { role: actor.role, companyId: safeText(request.headers.get("x-unigames-company-id"), 80), permissions: actor.permissions };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (!ACTIONS.includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM LANÇAMENTO." }, 400);
    if (ids.length > 1000) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 1000)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;
    const has = (key: string) => fields[key] !== undefined;
    const flag = (value: unknown) => (value === true || value === 1 ? 1 : 0);

    if (action === "classify") {
      if (!["categoryItemId", "subcategory", "companyId", "costCenterId", "inDre", "inRateio"].some(has)) {
        return jsonResponse({ error: "PREENCHA AO MENOS UM CAMPO DA CLASSIFICAÇÃO." }, 400);
      }
      const companyId = safeText(fields.companyId, 80);
      if (has("companyId") && companyId && !hasCompany(companyId)) return jsonResponse({ error: "UNIDADE INVÁLIDA." }, 400);
      if (has("companyId") && companyId && !allStores && companyId !== scopeActor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO PODE MOVER PARA ESSA LOJA." }, 403);
      }
    }

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, company_id AS companyId, raw_merchant AS rawMerchant, description, category_item_id AS categoryItemId,
                subcategory, cost_center_id AS costCenterId, in_dre AS inDre, in_rateio AS inRateio, status
         FROM finance_bank_statement_entries WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...ids)
      .all<Entry>();
    const entries = found.results ?? [];
    if (entries.length !== ids.length) return jsonResponse({ error: "ALGUM LANÇAMENTO SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    if (!allStores && entries.some((entry) => entry.companyId !== scopeActor.companyId)) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ALGUM LANÇAMENTO SELECIONADO." }, 403);
    }

    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const statements: [string, unknown[]][] = [];
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const seenRules = new Map<string, { id: string; hits: number }>();
    for (const entry of entries) {
      const skip = (reason: string) => skipped.push({ id: entry.id, description: entry.description, reason });
      if (entry.status === "expensed") { skip("JÁ VIROU DESPESA"); continue; }
      if (entry.status === "credit_sale") { skip("VINCULADO A CREDIÁRIO — DESFAÇA PELO CREDIÁRIO"); continue; }
      if (action === "unclassify") {
        if (entry.status === "pending") { skip("JÁ ESTÁ A CLASSIFICAR"); continue; }
        statements.push([
          `UPDATE finance_bank_statement_entries SET status='pending', updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3`,
          [who.id, who.name, entry.id],
        ]);
        continue;
      }
      if (entry.status === "confirmed") { skip("JÁ CONFIRMADO"); continue; }
      const next = {
        categoryItemId: has("categoryItemId") ? safeText(fields.categoryItemId, 80) : entry.categoryItemId,
        subcategory: has("subcategory") ? safeText(fields.subcategory, 120) : entry.subcategory,
        costCenterId: has("costCenterId") ? safeText(fields.costCenterId, 80) : entry.costCenterId,
        companyId: has("companyId") && safeText(fields.companyId, 80) ? safeText(fields.companyId, 80) : entry.companyId,
        inDre: has("inDre") ? flag(fields.inDre) : Number(entry.inDre),
        inRateio: has("inRateio") ? flag(fields.inRateio) : Number(entry.inRateio),
      };
      if (action === "confirm" && !next.categoryItemId) { skip("ESCOLHA A CATEGORIA ANTES DE CONFIRMAR"); continue; }
      const status = action === "confirm" ? "confirmed" : next.categoryItemId ? "classified" : "pending";
      statements.push([
        `UPDATE finance_bank_statement_entries
         SET category_item_id=?1, subcategory=?2, cost_center_id=?3, company_id=?4, in_dre=?5, in_rateio=?6, status=?7,
             updated_by=?8, updated_by_name=?9, updated_at=CURRENT_TIMESTAMP
         WHERE id=?10`,
        [next.categoryItemId, next.subcategory, next.costCenterId, next.companyId, next.inDre, next.inRateio, status, who.id, who.name, entry.id],
      ]);
      if (action === "confirm") {
        statements.push(...(await planRuleLearning(database, next.companyId, entry.rawMerchant, next, who, seenRules)));
      }
    }
    if (statements.length) await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied: entries.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote da conciliação bancária.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
