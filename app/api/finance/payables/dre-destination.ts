import type { getD1 } from "../../../../db";
import {
  allocationSlots,
  allocationsFor,
  destinationFromAllocations,
  includeDestination,
  insertAllocationsSql,
  isDreTarget,
  legacyDestination,
  noneDestination,
  type DreAllocation,
  type DreDestination,
} from "../../../lib/dre-destination";
import { recalcPayableEntrySql } from "../../../lib/payables-recurrence";
import { RATEIO_MODELS, type RateioModel } from "../../../lib/rateio-models";
import { computeRateioShares } from "../expenses/rateio";
import { loadCompanyList, safeText, type JsonMap } from "../shared";

type Database = Awaited<ReturnType<typeof getD1>>;
type Statement = [string, unknown[]];

/**
 * Lê o DESTINO NA DRE do corpo da requisição (Contas a Pagar, Dívidas com
 * Fornecedores e Notas Fiscais):
 *   dreTarget: 'none' | 'include' | 'rateio'
 *   dreCompanyId (INCLUIR EM), dreFinanceItemId (categoria; padrão = a da conta),
 *   dreRateioModel, dreRateioCompanyIds, dreRateioShares (RATEAR — mesmo
 *   cálculo do rateio da Despesa, computeRateioShares).
 * Sem dreTarget: null = regra antiga (DRE da loja/categoria da conta) — só
 * para conta COM loja; conta sem loja sem destino vira NÃO INCLUIR.
 * Login de loja só lança em INCLUIR EM na própria loja.
 */
export async function parseDreDestination(
  database: Database,
  body: JsonMap,
  context: {
    companyId: string;
    companyName: string;
    financeItemId: string;
    competenceMonth: string;
    totalAmountCents: number;
    allStores: boolean;
    actorCompanyId: string;
  },
): Promise<{ destination: DreDestination | null } | { error: string; status: number }> {
  const raw = safeText(body.dreTarget, 20);
  if (!raw) return { destination: context.companyId ? null : noneDestination() };
  if (!isDreTarget(raw)) return { error: "DESTINO NA DRE INVÁLIDO.", status: 400 };
  if (raw === "none") return { destination: noneDestination() };

  const itemId = safeText(body.dreFinanceItemId, 80) || context.financeItemId;
  if (!itemId) return { error: "ESCOLHA A CATEGORIA EM QUE A CONTA ENTRA NA DRE.", status: 400 };
  const item = await database.prepare("SELECT id FROM finance_items WHERE id=?1").bind(itemId).first<{ id: string }>();
  if (!item) return { error: "CATEGORIA DA DRE NÃO ENCONTRADA NO CATÁLOGO FINANCEIRO.", status: 400 };

  if (raw === "include") {
    const storeId = safeText(body.dreCompanyId, 80) || context.companyId;
    if (!storeId) return { error: "ESCOLHA A LOJA EM QUE A CONTA ENTRA NA DRE.", status: 400 };
    if (!context.allStores && storeId !== context.actorCompanyId) {
      return { error: "VOCÊ SÓ PODE LANÇAR NA DRE DA PRÓPRIA LOJA.", status: 403 };
    }
    const companies = await loadCompanyList(database);
    const company = companies.find((row) => row.id === storeId);
    if (!company) return { error: "LOJA DA DRE NÃO ENCONTRADA.", status: 400 };
    return { destination: includeDestination(company.id, company.name, itemId) };
  }

  const model = safeText(body.dreRateioModel, 30) as RateioModel;
  if (!RATEIO_MODELS.includes(model)) return { error: "SELECIONE O MODELO DE RATEIO DA DRE.", status: 400 };
  const customShares = Array.isArray(body.dreRateioShares)
    ? (body.dreRateioShares as JsonMap[]).map((entry) => ({
        companyId: safeText(entry.companyId, 80),
        percentBasisPoints: Math.round(Number(entry.percentBasisPoints)),
      }))
    : undefined;
  const companyIds = Array.isArray(body.dreRateioCompanyIds)
    ? (body.dreRateioCompanyIds as unknown[]).map((value) => safeText(value, 80)).filter(Boolean)
    : undefined;
  const result = await computeRateioShares(database, {
    model,
    competenceMonth: context.competenceMonth,
    totalAmountCents: Math.max(1, context.totalAmountCents),
    customShares,
    companyIds,
  });
  if ("error" in result) return result;
  return {
    destination: {
      target: "rateio",
      itemId,
      rateioModel: model,
      shares: result.shares.map(({ companyId, companyName, percentBasisPoints }) => ({ companyId, companyName, percentBasisPoints })),
    },
  };
}

type AllocationRow = Pick<DreAllocation, "payableId" | "storeId" | "storeName" | "itemId" | "month" | "percentBasisPoints">;

async function loadAllocations(database: Database, payableIds: string[]): Promise<AllocationRow[]> {
  const ids = [...new Set(payableIds.filter(Boolean))];
  if (!ids.length) return [];
  const rows = await database
    .prepare(
      `SELECT payable_id AS payableId, store_id AS storeId, store_name AS storeName, item_id AS itemId, month,
              percent_basis_points AS percentBasisPoints
       FROM finance_dre_allocations WHERE payable_id IN (${ids.map((_, index) => `?${index + 1}`).join(",")})
       ORDER BY payable_id, percent_basis_points DESC, store_id`,
    )
    .bind(...ids)
    .all<AllocationRow>();
  return rows.results ?? [];
}

/** Destino atual de uma conta (gravado, ou o equivalente da regra antiga). */
export async function loadPayableDestination(
  database: Database,
  payable: {
    id: string;
    companyId: string;
    companyName: string;
    financeItemId: string;
    dreAmountCents: number | null;
    dreTarget?: string;
    dreRateioModel?: string;
  },
): Promise<DreDestination> {
  if (!payable.dreTarget || !isDreTarget(payable.dreTarget)) return legacyDestination(payable);
  const allocations = (await loadAllocations(database, [payable.id])).filter((row) => row.payableId === payable.id);
  return destinationFromAllocations(payable.dreTarget, payable.dreRateioModel || "", allocations);
}

/**
 * Grava o destino em linhas de accounts_payable (apaga as fatias antigas e
 * cria as novas pelo valor de DRE de cada linha). Devolve os SQL e as
 * células que precisam ser recalculadas (as antigas E as novas).
 */
export async function planDreDestination(
  database: Database,
  destination: DreDestination,
  rows: Array<{ payableId: string; month: string; amountCents: number }>,
): Promise<{ statements: Statement[]; slots: Array<{ storeId: string; itemId: string; month: string }> }> {
  const ids = rows.map((row) => row.payableId);
  const previous = await loadAllocations(database, ids);
  const next = allocationsFor(destination, rows);
  const statements: Statement[] = [];
  for (const id of ids) statements.push(["DELETE FROM finance_dre_allocations WHERE payable_id=?1", [id]]);
  for (const id of ids) {
    statements.push([
      "UPDATE accounts_payable SET dre_target=?1, dre_rateio_model=?2 WHERE id=?3",
      [destination.target, destination.target === "rateio" ? destination.rateioModel : "", id],
    ]);
  }
  statements.push(...insertAllocationsSql(next));
  return { statements, slots: allocationSlots([...previous, ...next]) };
}

/** Células das fatias já gravadas (para recalcular ao cancelar/excluir). */
export async function allocationSlotsOf(database: Database, payableIds: string[]) {
  return allocationSlots(await loadAllocations(database, payableIds));
}

export function recalcSlotsSql(
  slots: Array<{ storeId: string; itemId: string; month: string }>,
  actor: { id: string; name: string },
): Statement[] {
  return slots.flatMap((slot) =>
    recalcPayableEntrySql(crypto.randomUUID(), slot.storeId, slot.itemId, slot.month, actor.id, actor.name),
  );
}
