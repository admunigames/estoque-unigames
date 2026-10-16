import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN, progressPercent } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  actorName,
  canManageCommercialWeekend,
  canViewCommercialWeekend,
  commercialScope,
  identity,
  jsonResponse,
  loadCompanyNames,
  nonNegativeInt,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Aba META DO FIM DE SEMANA (comercial:weekend_view ver, comercial:weekend editar): feito, meta,
// meta de itens e itens vendidos de cada loja POR FIM DE SEMANA, lançados à
// mão. SÓ CONTROLE: não alimenta vendedores, comissão nem RH (nenhum
// syncHrCommissions aqui). O fim de semana é identificado pelo SÁBADO
// (YYYY-MM-DD) e pertence ao mês desse sábado.
//   GET ?month&weekend → sábados do mês, linhas das lojas do alcance e total
//   PUT {weekend, companyId, targetCents, revenueCents, targetItems, items}

type Row = { companyId: string; targetCents: number; revenueCents: number; targetItems: number; items: number };

/** Sábados do mês (YYYY-MM-DD). */
function saturdaysOf(month: string): string[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const list: string[] = [];
  for (let day = 1; day <= days; day++) {
    if (new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay() === 6) list.push(`${month}-${String(day).padStart(2, "0")}`);
  }
  return list;
}

function isSaturday(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && MONTH_PATTERN.test(value.slice(0, 7)) && saturdaysOf(value.slice(0, 7)).includes(value);
}

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (request.method === "GET" ? !canViewCommercialWeekend(actor) : !canManageCommercialWeekend(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA A META DO FIM DE SEMANA." }, 403) };
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
  const { scope } = checked;
  const url = new URL(request.url);
  const today = todayInTimezone();
  const requested = safeText(url.searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : today.slice(0, 7);
  const weekends = saturdaysOf(month);
  const wanted = safeText(url.searchParams.get("weekend"), 10);
  // Padrão: o último fim de semana já começado no mês (ou o primeiro).
  const weekend = weekends.includes(wanted) ? wanted : [...weekends].reverse().find((day) => day <= today) || weekends[0];
  try {
    const database = await getD1();
    const [result, companyNames] = await Promise.all([
      database
        .prepare(
          `SELECT company_id AS companyId, target_cents AS targetCents, revenue_cents AS revenueCents,
                  target_items AS targetItems, items
           FROM commercial_weekend_goals WHERE weekend=?1`,
        )
        .bind(weekend)
        .all<Row>(),
      loadCompanyNames(database),
    ]);
    const saved = new Map((result.results ?? []).map((row) => [row.companyId, row]));
    const rows = [...companyNames.entries()]
      .filter(([companyId]) => scope.allStores || companyId === scope.companyId)
      .map(([companyId, name]) => {
        const row = saved.get(companyId);
        return {
          companyId, name,
          targetCents: Number(row?.targetCents) || 0, revenueCents: Number(row?.revenueCents) || 0,
          targetItems: Number(row?.targetItems) || 0, items: Number(row?.items) || 0,
        };
      });
    const sum = (key: keyof Row) => rows.reduce((total, row) => total + (row[key] as number), 0);
    return jsonResponse({
      month, weekends, weekend, rows, canEdit: canManageCommercialWeekend(checked.actor),
      total: {
        targetCents: sum("targetCents"), revenueCents: sum("revenueCents"),
        percent: progressPercent(sum("revenueCents"), sum("targetCents")),
        targetItems: sum("targetItems"), items: sum("items"),
      },
    });
  } catch (error) {
    console.error("Não foi possível carregar a meta do fim de semana.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A META DO FIM DE SEMANA." }, 500);
  }
}

export async function PUT(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const weekend = safeText(body.weekend, 10);
    const companyId = safeText(body.companyId, 80);
    const values = ["targetCents", "revenueCents", "targetItems", "items"].map((key) => nonNegativeInt(body[key] ?? 0));
    if (!isSaturday(weekend)) return jsonResponse({ error: "ESCOLHA O FIM DE SEMANA." }, 400);
    if (values.some((value) => value === null)) {
      return jsonResponse({ error: "META E FEITO PRECISAM SER POSITIVOS (OU ZERO)." }, 400);
    }
    const database = await getD1();
    const companyNames = await loadCompanyNames(database);
    if (!companyNames.has(companyId) || (!scope.allStores && companyId !== scope.companyId)) {
      return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 404);
    }
    await database
      .prepare(
        `INSERT INTO commercial_weekend_goals
          (id, weekend, month, company_id, target_cents, revenue_cents, target_items, items, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (weekend, company_id) DO UPDATE SET
           target_cents=excluded.target_cents, revenue_cents=excluded.revenue_cents,
           target_items=excluded.target_items, items=excluded.items,
           updated_by=excluded.updated_by, updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), weekend, weekend.slice(0, 7), companyId, ...values, actor.id, actorName(actor), new Date().toISOString())
      .run();
    return jsonResponse({ weekend, companyId });
  } catch (error) {
    console.error("Não foi possível salvar a meta do fim de semana.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A META DO FIM DE SEMANA." }, 500);
  }
}
