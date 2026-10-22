import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN, progressPercent } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  actorName,
  canAccessCommercial,
  canManageCommercialStores,
  canViewCommercialStores,
  commercialScope,
  identity,
  jsonResponse,
  loadCompanyNames,
  nonNegativeInt,
  safeText,
  sameOrigin,
  syncHrCommissions,
  type JsonMap,
} from "../shared";

// Meta Loja: meta e feito de VENDAS do mês de cada loja (R$) — a assistência
// fica na Meta Assistência (pedido de 2026-10-22) —, META ITENS / ITENS FEITO e
// META REALME / REALMES FEITO, tudo lançado à mão (o feito da loja não é a
// soma dos vendedores). O TOTAL DA LOJA = vendas + assistência, e é ele que
// vale no ranking, nas comissões e nas premiações.
//   GET ?month → painel visual para TODOS do Comercial: só o % TOTAL de cada
//                loja com meta e o % da rede (nenhum R$). Quem tem
//                comercial:stores_view (ver) ou comercial:stores (editar,
//                canManage) recebe também os valores das lojas do seu
//                alcance (`rows`: vendas editáveis, assistência só leitura e
//                o total); o total em R$ só com todas.
//                `itemStores` = itens e realmes de cada loja (quantidades,
//                gráficos ITENS/REALMES TOTAIS POR LOJA do Ranking) — para todos.
//                INDICAÇÃO (quantidade) e R$ DE INDICAÇÃO só em `rows` (só controle).
//   PUT {month, companyId, targetCents, revenueCents, targetItems, items, targetRealme, realme,
//        indicationQty, indicationCents} → comercial:stores, só lojas do alcance de quem
//       lança. Recalcula a comissão de líderes e operacionais no RH. META/FEITO
//       DA ASSISTÊNCIA ficam na rota /assistance (não são tocados aqui).

type GoalRow = {
  companyId: string; targetCents: number; revenueCents: number;
  targetItems: number; items: number; targetRealme: number; realme: number;
  indicationQty: number; indicationCents: number; assistTargetCents: number; assistRevenueCents: number;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }
  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);
  try {
    const database = await getD1();
    const [result, companyNames] = await Promise.all([
      database
        .prepare(
          `SELECT company_id AS companyId, target_cents AS targetCents, revenue_cents AS revenueCents,
                  target_items AS targetItems, items, target_realme AS targetRealme, realme,
                  indication_qty AS indicationQty, indication_cents AS indicationCents,
                  assist_target_cents AS assistTargetCents, assist_revenue_cents AS assistRevenueCents
           FROM commercial_store_goals WHERE month=?1`,
        )
        .bind(month)
        .all<GoalRow>(),
      loadCompanyNames(database),
    ]);
    const goals = new Map((result.results ?? []).map((row) => [row.companyId, row]));
    // TOTAL DA LOJA = vendas (Meta Loja) + assistência (Meta Assistência).
    const totalOf = (goal: GoalRow | undefined) => ({
      targetCents: (Number(goal?.targetCents) || 0) + (Number(goal?.assistTargetCents) || 0),
      revenueCents: (Number(goal?.revenueCents) || 0) + (Number(goal?.assistRevenueCents) || 0),
    });
    const withTarget = [...companyNames.entries()]
      .map(([companyId, name]) => ({ companyId, name, total: totalOf(goals.get(companyId)) }))
      .filter((store) => store.total.targetCents > 0);
    const targetSum = withTarget.reduce((sum, store) => sum + store.total.targetCents, 0);
    const revenueSum = withTarget.reduce((sum, store) => sum + store.total.revenueCents, 0);
    const items = withTarget
      .map((store) => ({
        companyId: store.companyId,
        name: store.name,
        percent: progressPercent(store.total.revenueCents, store.total.targetCents),
      }))
      .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0) || a.name.localeCompare(b.name, "pt-BR"));
    const itemStores = [...companyNames.entries()]
      .map(([companyId, name]) => {
        const goal = goals.get(companyId);
        return {
          companyId, name,
          items: Number(goal?.items) || 0, targetItems: Number(goal?.targetItems) || 0,
          realme: Number(goal?.realme) || 0, targetRealme: Number(goal?.targetRealme) || 0,
        };
      })
      .filter((store) => store.items > 0 || store.targetItems > 0 || store.realme > 0 || store.targetRealme > 0);
    const body: JsonMap = {
      month, items, itemStores,
      totalPercent: progressPercent(revenueSum, targetSum),
    };

    const scope = commercialScope(actor);
    if (canViewCommercialStores(actor) && scope) {
      body.canManage = canManageCommercialStores(actor);
      body.rows = [...companyNames.entries()]
        .filter(([companyId]) => scope.allStores || companyId === scope.companyId)
        .map(([companyId, name]) => ({
          companyId,
          name,
          targetCents: Number(goals.get(companyId)?.targetCents) || 0,
          revenueCents: Number(goals.get(companyId)?.revenueCents) || 0,
          targetItems: Number(goals.get(companyId)?.targetItems) || 0,
          items: Number(goals.get(companyId)?.items) || 0,
          targetRealme: Number(goals.get(companyId)?.targetRealme) || 0,
          realme: Number(goals.get(companyId)?.realme) || 0,
          indicationQty: Number(goals.get(companyId)?.indicationQty) || 0,
          indicationCents: Number(goals.get(companyId)?.indicationCents) || 0,
          // Só leitura aqui (lançadas na Meta Assistência).
          assistTargetCents: Number(goals.get(companyId)?.assistTargetCents) || 0,
          assistRevenueCents: Number(goals.get(companyId)?.assistRevenueCents) || 0,
        }));
      if (scope.allStores) body.total = { targetCents: targetSum, revenueCents: revenueSum };
    }
    return jsonResponse(body);
  } catch (error) {
    console.error("Não foi possível carregar as metas das lojas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS METAS DAS LOJAS." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercialStores(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR AS METAS DAS LOJAS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const month = safeText(body.month, 7);
    const companyId = safeText(body.companyId, 80);
    const targetCents = nonNegativeInt(body.targetCents ?? 0);
    const revenueCents = nonNegativeInt(body.revenueCents ?? 0);
    const targetItems = nonNegativeInt(body.targetItems ?? 0);
    const items = nonNegativeInt(body.items ?? 0);
    const targetRealme = nonNegativeInt(body.targetRealme ?? 0);
    const realme = nonNegativeInt(body.realme ?? 0);
    const indicationQty = nonNegativeInt(body.indicationQty ?? 0);
    const indicationCents = nonNegativeInt(body.indicationCents ?? 0);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
    if ([targetCents, revenueCents, targetItems, items, targetRealme, realme, indicationQty, indicationCents].some((value) => value === null)) {
      return jsonResponse({ error: "META E FEITO PRECISAM SER POSITIVOS (OU ZERO)." }, 400);
    }
    const database = await getD1();
    const companyNames = await loadCompanyNames(database);
    if (!companyNames.has(companyId) || (!scope.allStores && companyId !== scope.companyId)) {
      return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 404);
    }
    await database
      .prepare(
        `INSERT INTO commercial_store_goals
          (id, month, company_id, target_cents, revenue_cents, updated_by, updated_by_name, updated_at,
           target_items, items, target_realme, realme, indication_qty, indication_cents)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (month, company_id) DO UPDATE SET
           target_cents=excluded.target_cents, revenue_cents=excluded.revenue_cents,
           target_items=excluded.target_items, items=excluded.items,
           target_realme=excluded.target_realme, realme=excluded.realme,
           indication_qty=excluded.indication_qty, indication_cents=excluded.indication_cents,
           updated_by=excluded.updated_by, updated_by_name=excluded.updated_by_name,
           updated_at=excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), month, companyId, targetCents, revenueCents, actor.id, actorName(actor), new Date().toISOString(), targetItems, items, targetRealme, realme, indicationQty, indicationCents)
      .run();
    // Meta/feito da loja e da assistência mudam o líder e os operacionais.
    await syncHrCommissions(database, month, actor);
    return jsonResponse({ companyId, month });
  } catch (error) {
    console.error("Não foi possível salvar a meta da loja.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A META DA LOJA." }, 500);
  }
}
