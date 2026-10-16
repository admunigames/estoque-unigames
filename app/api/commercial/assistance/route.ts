import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN, monthClock, resolveCommercialRules } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  actorName,
  canManageCommercialAssist,
  canViewCommercialAssist,
  commercialScope,
  identity,
  jsonResponse,
  loadCompanyNames,
  loadRules,
  nonNegativeInt,
  previousMonth,
  safeText,
  sameOrigin,
  syncHrCommissions,
  type JsonMap,
} from "../shared";

// Aba META ASSISTÊNCIA (comercial:assist_view ver, comercial:assist editar):
// META e FEITO DA ASSISTÊNCIA de cada loja no mês — base da comissão do
// OPERACIONAL e do prêmio do LÍDER (loja E assistência na meta 120%). Grava
// só as colunas da assistência em commercial_store_goals (a Meta Loja não
// mexe nelas, e esta rota não mexe nas da loja).
//   GET ?month → lojas do alcance com meta/feito do mês e do mês anterior
//                (comparativo), dias restantes e a % da meta de premiação
//   PUT {month, companyId, assistTargetCents, assistRevenueCents}

type GoalRow = { companyId: string; month: string; targetCents: number; revenueCents: number; updatedAt: string; updatedByName: string };

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (request.method === "GET" ? !canViewCommercialAssist(actor) : !canManageCommercialAssist(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA A META ASSISTÊNCIA." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) {
    return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  }
  const scope = commercialScope(actor);
  if (!scope) return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  return { actor, scope };
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  const today = todayInTimezone();
  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : today.slice(0, 7);
  const previous = previousMonth(month);
  try {
    const database = await getD1();
    const [result, companyNames, allRules] = await Promise.all([
      database
        .prepare(
          `SELECT company_id AS companyId, month, assist_target_cents AS targetCents, assist_revenue_cents AS revenueCents,
                  assist_updated_at AS updatedAt, assist_updated_by_name AS updatedByName
           FROM commercial_store_goals WHERE month IN (?1, ?2)`,
        )
        .bind(month, previous)
        .all<GoalRow>(),
      loadCompanyNames(database),
      loadRules(database),
    ]);
    const key = (row: { month: string; companyId: string }) => `${row.month}|${row.companyId}`;
    const goals = new Map((result.results ?? []).map((row) => [key(row), row]));
    const rows = [...companyNames.entries()]
      .filter(([companyId]) => scope.allStores || companyId === scope.companyId)
      .map(([companyId, name]) => {
        const current = goals.get(key({ month, companyId }));
        const before = goals.get(key({ month: previous, companyId }));
        return {
          companyId,
          name,
          targetCents: Number(current?.targetCents) || 0,
          revenueCents: Number(current?.revenueCents) || 0,
          previousTargetCents: Number(before?.targetCents) || 0,
          previousRevenueCents: Number(before?.revenueCents) || 0,
          updatedAt: current?.updatedAt || "",
          updatedByName: current?.updatedByName || "",
        };
      });
    const roles = resolveCommercialRules(allRules, month).roles;
    return jsonResponse({
      month,
      previousMonth: previous,
      clock: monthClock(month, today),
      // Meta de premiação (120%) da vigência do mês; sem regras de operacional, 120.
      premiumPercent: roles ? roles.operational.premiumPercent : 120,
      canEdit: canManageCommercialAssist(actor),
      rows,
    });
  } catch (error) {
    console.error("Não foi possível carregar a meta da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A META DA ASSISTÊNCIA." }, 500);
  }
}

export async function PUT(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const month = safeText(body.month, 7);
    const companyId = safeText(body.companyId, 80);
    const targetCents = nonNegativeInt(body.assistTargetCents ?? 0);
    const revenueCents = nonNegativeInt(body.assistRevenueCents ?? 0);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
    if (targetCents === null || revenueCents === null) {
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
          (id, month, company_id, assist_target_cents, assist_revenue_cents, assist_updated_at, assist_updated_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (month, company_id) DO UPDATE SET
           assist_target_cents=excluded.assist_target_cents, assist_revenue_cents=excluded.assist_revenue_cents,
           assist_updated_at=excluded.assist_updated_at, assist_updated_by_name=excluded.assist_updated_by_name`,
      )
      .bind(crypto.randomUUID(), month, companyId, targetCents, revenueCents, new Date().toISOString(), actorName(actor))
      .run();
    // A assistência muda a comissão dos operacionais e o prêmio do líder.
    await syncHrCommissions(database, month, actor);
    return jsonResponse({ companyId, month });
  } catch (error) {
    console.error("Não foi possível salvar a meta da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A META DA ASSISTÊNCIA." }, 500);
  }
}
