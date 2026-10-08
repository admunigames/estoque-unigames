// Distribuição pura de um valor entre lojas por percentual (pontos-base).
// Extraído para lib para poder ser testado sem tocar no banco.

export const BASIS_POINTS_TOTAL = 10000;

export type RateioShareInput = {
  companyId: string;
  companyName: string;
  percentBasisPoints: number;
};

export type RateioShare = RateioShareInput & { amountCents: number };

/**
 * Arredonda cada fatia e joga o resto do arredondamento na ÚLTIMA fatia —
 * mesma técnica de splitIntoInstallments, pra soma bater exatamente com o
 * total centavo a centavo.
 */
export function distributeAmount(
  totalAmountCents: number,
  shares: RateioShareInput[],
): RateioShare[] {
  let allocated = 0;
  return shares.map((share, index) => {
    const isLast = index === shares.length - 1;
    const amountCents = isLast
      ? totalAmountCents - allocated
      : Math.round((totalAmountCents * share.percentBasisPoints) / BASIS_POINTS_TOTAL);
    allocated += amountCents;
    return { ...share, amountCents };
  });
}

export type RateioWeight = { companyId: string; companyName: string; weight: number };

/**
 * Pesos (percentual do modelo, faturamento, nº de funcionários…) → pontos-base
 * somando EXATAMENTE 10000, pelo maior resto (a sobra vai para as maiores
 * frações, empate pela ordem da lista).
 */
export function weightsToBasisPoints(weights: RateioWeight[]): RateioShareInput[] {
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return [];
  const raw = weights.map((item) => (item.weight * BASIS_POINTS_TOTAL) / total);
  const shares = weights.map((item, index) => ({ companyId: item.companyId, companyName: item.companyName, percentBasisPoints: Math.floor(raw[index]) }));
  let left = BASIS_POINTS_TOTAL - shares.reduce((sum, share) => sum + share.percentBasisPoints, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    shares[index].percentBasisPoints += 1;
    left -= 1;
  }
  return shares;
}

/**
 * Rateio só entre as lojas ESCOLHIDAS: o peso de cada uma vem do modelo
 * (loja fora do modelo = peso 0); lojas sem peso ficam de fora (skipped).
 * Uma loja só = 100% para ela, mesmo sem peso no modelo. Várias escolhidas e
 * nenhuma com peso = erro.
 */
export function restrictRateioWeights(
  weights: RateioWeight[],
  chosen: Array<{ id: string; name: string }>,
): { weights: RateioWeight[]; skipped: Array<{ companyId: string; companyName: string }> } | { error: string } {
  const byId = new Map(weights.map((item) => [item.companyId, item]));
  const picked = chosen.map((company) => ({
    companyId: company.id,
    companyName: byId.get(company.id)?.companyName || company.name,
    weight: Math.max(0, byId.get(company.id)?.weight ?? 0),
  }));
  if (picked.length === 1) return { weights: [{ ...picked[0], weight: 1 }], skipped: [] };
  const positive = picked.filter((item) => item.weight > 0);
  if (!positive.length) return { error: "AS LOJAS ESCOLHIDAS NÃO TÊM PESO NESSE MODELO DE RATEIO — ESCOLHA OUTRAS LOJAS OU USE O PERSONALIZADO." };
  return {
    weights: positive,
    skipped: picked.filter((item) => item.weight <= 0).map(({ companyId, companyName }) => ({ companyId, companyName })),
  };
}
