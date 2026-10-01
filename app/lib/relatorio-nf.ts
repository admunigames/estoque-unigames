// Lógica pura (sem I/O) do módulo "Comercial > Relatório NF" — lançamento
// manual diário de vendas x notas fiscais emitidas por loja.
//
// Fica DE PROPÓSITO sem imports de outros módulos do projeto — mesma
// escolha já feita em app/lib/supplier-invoice-status.ts, pra poder ser
// testada diretamente via `node --test` sem precisar do resolvedor de
// módulos do bundler.

export const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type NfStoreEntry = {
  storeId: string;
  storeName: string;
  salesCount: number;
  invoicesIssuedCount: number;
  salesAmountCents: number;
  invoicesIssuedAmountCents: number;
};

export type NfTotals = {
  totalSalesCount: number;
  totalInvoicesIssuedCount: number;
  totalSalesAmountCents: number;
  totalInvoicesIssuedAmountCents: number;
  pendingCount: number;
  pendingAmountCents: number;
  // 0-100, arredondado só na exibição — aqui fica com casas decimais pra
  // não perder precisão em agregações futuras (ex. média de vários dias).
  pctIssued: number;
};

/**
 * % de emissão de uma única loja/linha. Retorna 0 quando não há vendas
 * (evita divisão por zero) — não há "sem dado" nesse painel: loja sem
 * lançamento aparece zerada, igual a uma loja com 0 vendas reais.
 */
export function computeNfStorePct(salesCount: number, invoicesIssuedCount: number): number {
  if (salesCount <= 0) return 0;
  return (invoicesIssuedCount / salesCount) * 100;
}

/**
 * Totais gerais de um dia a partir das linhas por loja. `pendingCount`/
 * `pendingAmountCents` nunca ficam negativos (Math.max com 0) — se uma
 * loja lançar mais emitidas do que vendas (erro de digitação), isso não
 * deve "sobrar" pra outra loja nem gerar pendente negativo.
 */
export function computeNfTotals(entries: NfStoreEntry[]): NfTotals {
  const totalSalesCount = entries.reduce((sum, entry) => sum + entry.salesCount, 0);
  const totalInvoicesIssuedCount = entries.reduce((sum, entry) => sum + entry.invoicesIssuedCount, 0);
  const totalSalesAmountCents = entries.reduce((sum, entry) => sum + entry.salesAmountCents, 0);
  const totalInvoicesIssuedAmountCents = entries.reduce(
    (sum, entry) => sum + entry.invoicesIssuedAmountCents,
    0,
  );
  return {
    totalSalesCount,
    totalInvoicesIssuedCount,
    totalSalesAmountCents,
    totalInvoicesIssuedAmountCents,
    pendingCount: Math.max(0, totalSalesCount - totalInvoicesIssuedCount),
    pendingAmountCents: Math.max(0, totalSalesAmountCents - totalInvoicesIssuedAmountCents),
    pctIssued: computeNfStorePct(totalSalesCount, totalInvoicesIssuedCount),
  };
}
