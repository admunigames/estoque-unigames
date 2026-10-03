import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany } from "../../../lib/access-scope";
import { addDays, todayInTimezone } from "../../../lib/finance-status";
import { OVERDUE_DAYS, recifeDayStartIso } from "../../../lib/divergences";
import {
  allStoresForAny,
  can,
  canAny,
  identity,
  jsonResponse,
  READ_PERMISSIONS,
} from "../shared";

type CountRow = { status: string; total: number | string };
type RecentRow = {
  id: string;
  companyName: string;
  status: string;
  createdAt: string;
  itemStatus: string | null;
};

// Números leves para os widgets da Início:
// - estoque (divergencias:respond): contadores por status + alerta de item
//   em NÃO VISTO há mais de 14 dias (data de criação, fuso Recife);
// - loja: pedidos recentes com selo RESPONDIDO / AGUARDANDO RETORNO e itens
//   esperando a verificação da própria loja.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAny(actor, READ_PERMISSIONS)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VISUALIZAR AS DIVERGÊNCIAS." }, 403);
  }
  try {
    const allStores = allStoresForAny(actor, READ_PERMISSIONS);
    if (!allStores && !hasCompany(actor.companyId)) {
      return jsonResponse({ hidden: true });
    }
    const companyFilter = allStores ? "" : actor.companyId;
    const database = await getD1();
    const now = new Date();
    const today = todayInTimezone(now);
    // Criado num dia de Recife ANTERIOR a (hoje − 14) ⇒ mais de 14 dias.
    const overdueBefore = recifeDayStartIso(addDays(today, -OVERDUE_DAYS));
    const respondedSince = recifeDayStartIso(addDays(today, -30));
    // Filtro de loja só entra na query quando existe (parâmetro ?1); sem ele,
    // os demais parâmetros começam em ?1.
    const scope = companyFilter ? "r.company_id=?1 AND " : "";
    const scopeParams = companyFilter ? [companyFilter] : [];
    const next = scopeParams.length + 1;
    const [counts, respondedRow, overdueRow, recent] = await Promise.all([
      database
        .prepare(
          `SELECT i.status, COUNT(*) AS total
           FROM divergence_items i JOIN divergence_requests r ON r.id=i.request_id
           WHERE ${scope}i.status IN ('nao_visto','em_verificacao','verificacao_loja')
           GROUP BY i.status`,
        )
        .bind(...scopeParams)
        .all<CountRow>(),
      database
        .prepare(
          `SELECT COUNT(*) AS total
           FROM divergence_items i JOIN divergence_requests r ON r.id=i.request_id
           WHERE ${scope}i.status IN ('concluido','inventario') AND i.responded_at>=?${next}`,
        )
        .bind(...scopeParams, respondedSince)
        .first<{ total: number | string }>(),
      database
        .prepare(
          `SELECT COUNT(*) AS total, MIN(i.created_at) AS oldest
           FROM divergence_items i JOIN divergence_requests r ON r.id=i.request_id
           WHERE ${scope}i.status='nao_visto' AND i.created_at<?${next}`,
        )
        .bind(...scopeParams, overdueBefore)
        .first<{ total: number | string; oldest: string | null }>(),
      database
        .prepare(
          `SELECT r.id, r.company_name AS companyName, r.status, r.created_at AS createdAt, i.status AS itemStatus
           FROM divergence_requests r LEFT JOIN divergence_items i ON i.request_id=r.id
           WHERE r.id IN (
             SELECT id FROM divergence_requests${companyFilter ? " WHERE company_id=?1" : ""}
             ORDER BY created_at DESC LIMIT 5
           )`,
        )
        .bind(...scopeParams)
        .all<RecentRow>(),
    ]);
    const byStatus: Record<string, number> = { nao_visto: 0, em_verificacao: 0, verificacao_loja: 0 };
    for (const row of counts.results ?? []) byStatus[row.status] = Number(row.total) || 0;

    const recentMap = new Map<string, {
      id: string; companyName: string; status: string; createdAt: string;
      itemCount: number; awaitingStore: number; awaitingStock: number;
    }>();
    for (const row of recent.results ?? []) {
      const entry = recentMap.get(row.id) || {
        id: row.id, companyName: row.companyName, status: row.status, createdAt: row.createdAt,
        itemCount: 0, awaitingStore: 0, awaitingStock: 0,
      };
      if (row.itemStatus) {
        entry.itemCount += 1;
        if (row.itemStatus === "verificacao_loja") entry.awaitingStore += 1;
        if (row.itemStatus === "nao_visto" || row.itemStatus === "em_verificacao") entry.awaitingStock += 1;
      }
      recentMap.set(row.id, entry);
    }
    return jsonResponse({
      view: can(actor, "divergencias:respond") ? "stock" : "store",
      allStores,
      counts: { ...byStatus, respondidos: Number(respondedRow?.total) || 0 },
      overdue: { count: Number(overdueRow?.total) || 0, oldestAt: overdueRow?.oldest || "", days: OVERDUE_DAYS },
      recent: [...recentMap.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((entry) => ({ ...entry, answered: entry.itemCount > 0 && entry.awaitingStock === 0 })),
    });
  } catch (error) {
    console.error("Não foi possível carregar o resumo de divergências.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RESUMO DE DIVERGÊNCIAS." }, 500);
  }
}
