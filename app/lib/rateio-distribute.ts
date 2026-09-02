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
