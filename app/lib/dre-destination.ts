// Destino na DRE de uma conta a pagar (Contas a Pagar, Dívidas com
// Fornecedores e Notas Fiscais) — lógica pura, sem banco. Quem lança a conta
// DISCRIMINA onde ela entra (decisão do usuário, 22/10/2026):
//   - NÃO INCLUIR ('none'): não entra em DRE nenhuma;
//   - INCLUIR EM ('include'): uma loja e uma categoria (100% nela);
//   - RATEAR ('rateio'): uma categoria dividida entre lojas pelo modelo.
// A loja da conta (opcional) não decide mais a DRE. Contas antigas
// (dre_target='') seguem a regra antiga: entram na DRE da própria loja e
// categoria (= INCLUIR EM), ou em nenhuma se dre_amount_cents=0.

import { BASIS_POINTS_TOTAL, distributeAmount, type RateioShareInput } from "./rateio-distribute";

export const DRE_TARGETS = ["none", "include", "rateio"] as const;
export type DreTarget = (typeof DRE_TARGETS)[number];

export const DRE_TARGET_LABELS: Record<DreTarget, string> = {
  none: "NÃO INCLUIR",
  include: "INCLUIR EM",
  rateio: "RATEAR",
};

export type DreDestination = {
  target: DreTarget;
  /** Categoria (finance_item) onde o valor entra. Vazio em 'none'. */
  itemId: string;
  /** Modelo do rateio (só em 'rateio'). */
  rateioModel: string;
  /** Lojas e percentuais (pontos-base somando 10000). Vazio em 'none'. */
  shares: RateioShareInput[];
};

export type DreAllocation = {
  payableId: string;
  storeId: string;
  storeName: string;
  itemId: string;
  month: string;
  percentBasisPoints: number;
  amountCents: number;
};

export function isDreTarget(value: unknown): value is DreTarget {
  return typeof value === "string" && (DRE_TARGETS as readonly string[]).includes(value);
}

export function noneDestination(): DreDestination {
  return { target: "none", itemId: "", rateioModel: "", shares: [] };
}

export function includeDestination(storeId: string, storeName: string, itemId: string): DreDestination {
  return {
    target: "include",
    itemId,
    rateioModel: "",
    shares: [{ companyId: storeId, companyName: storeName, percentBasisPoints: BASIS_POINTS_TOTAL }],
  };
}

/**
 * Destino equivalente de uma conta antiga (dre_target=''): INCLUIR EM a
 * própria loja/categoria, ou NÃO INCLUIR quando a DRE foi zerada (ou a conta
 * não tem loja — sem loja não há célula de DRE).
 */
export function legacyDestination(payable: {
  companyId: string;
  companyName: string;
  financeItemId: string;
  dreAmountCents: number | null;
}): DreDestination {
  const excluded = payable.dreAmountCents !== null && payable.dreAmountCents !== undefined && payable.dreAmountCents <= 0;
  if (excluded || !payable.companyId) return noneDestination();
  return includeDestination(payable.companyId, payable.companyName, payable.financeItemId);
}

/**
 * Fatias de cada linha de conta a pagar (uma por loja do destino), com o
 * valor da linha que vai para a DRE (dre_amount_cents ou o original) dividido
 * pelos percentuais — o resto do arredondamento fica na última loja, então a
 * soma das fatias bate com o valor da linha centavo a centavo.
 */
export function allocationsFor(
  destination: DreDestination,
  rows: Array<{ payableId: string; month: string; amountCents: number }>,
): DreAllocation[] {
  if (destination.target === "none" || !destination.shares.length || !destination.itemId) return [];
  return rows.flatMap((row) =>
    distributeAmount(Math.max(0, row.amountCents), destination.shares).map((share) => ({
      payableId: row.payableId,
      storeId: share.companyId,
      storeName: share.companyName,
      itemId: destination.itemId,
      month: row.month,
      percentBasisPoints: share.percentBasisPoints,
      amountCents: share.amountCents,
    })),
  );
}

/** Reconstrói o destino gravado a partir das fatias de UMA linha. */
export function destinationFromAllocations(
  target: DreTarget,
  rateioModel: string,
  allocations: Array<Pick<DreAllocation, "storeId" | "storeName" | "itemId" | "percentBasisPoints">>,
): DreDestination {
  if (target === "none" || !allocations.length) return noneDestination();
  return {
    target,
    itemId: allocations[0].itemId,
    rateioModel: target === "rateio" ? rateioModel : "",
    shares: allocations.map((row) => ({
      companyId: row.storeId,
      companyName: row.storeName,
      percentBasisPoints: Number(row.percentBasisPoints),
    })),
  };
}

export function insertAllocationsSql(allocations: DreAllocation[]): [string, unknown[]][] {
  return allocations.map((row) => [
    `INSERT INTO finance_dre_allocations
      (id, payable_id, store_id, store_name, item_id, month, percent_basis_points, amount_cents, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP)`,
    [
      crypto.randomUUID(),
      row.payableId,
      row.storeId,
      row.storeName,
      row.itemId,
      row.month,
      row.percentBasisPoints,
      row.amountCents,
    ],
  ]);
}

/** Células (loja+categoria+mês) tocadas por um conjunto de fatias, sem repetição. */
export function allocationSlots(
  allocations: Array<Pick<DreAllocation, "storeId" | "itemId" | "month">>,
): Array<{ storeId: string; itemId: string; month: string }> {
  const slots = new Map<string, { storeId: string; itemId: string; month: string }>();
  for (const row of allocations) {
    slots.set(`${row.storeId}::${row.itemId}::${row.month}`, { storeId: row.storeId, itemId: row.itemId, month: row.month });
  }
  return [...slots.values()];
}
