// Lógica pura dos Crediários (Financeiro 7/9). Sem I/O: conta do valor com/
// sem taxa, situação derivada e sugestão de quais crediários um depósito do
// extrato quita. As rotas (app/api/finance/credit-sales/*) e o front
// (crComputeSale em public/estoque.html, comparado em teste) usam a mesma conta.

export type CreditSaleAmounts = { grossCents: number; feeBps: number; feeCents: number; netCents: number };

/**
 * VALOR COM TAXA (venda) − taxa da financeira = VALOR SEM TAXA (o que cai no
 * extrato). Pela taxa: taxa em centavos arredondada. Pelo valor sem taxa: a
 * taxa (em bps) é recalculada. null quando os valores não fecham.
 */
export function computeCreditSale(input: { grossCents: number; feeBps?: number | null; netCents?: number | null }): CreditSaleAmounts | null {
  const grossCents = Math.round(Number(input.grossCents));
  if (!Number.isFinite(grossCents) || grossCents <= 0) return null;
  if (input.netCents !== undefined && input.netCents !== null) {
    const netCents = Math.round(Number(input.netCents));
    if (!Number.isFinite(netCents) || netCents < 0 || netCents > grossCents) return null;
    const feeCents = grossCents - netCents;
    return { grossCents, feeBps: Math.round((feeCents * 10000) / grossCents), feeCents, netCents };
  }
  const feeBps = Math.round(Number(input.feeBps ?? 0));
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10000) return null;
  const feeCents = Math.round((grossCents * feeBps) / 10000);
  return { grossCents, feeBps, feeCents, netCents: grossCents - feeCents };
}

export type CreditSaleStatus = "pending" | "finished" | "canceled";

export const CREDIT_SALE_STATUS_LABELS: Record<CreditSaleStatus, string> = {
  pending: "PENDENTE",
  finished: "FINALIZADO",
  canceled: "CANCELADO",
};

/** CANCELADO > FINALIZADO (received_date preenchido) > PENDENTE. */
export function creditSaleStatus(row: { canceled?: unknown; receivedDate?: unknown }): CreditSaleStatus {
  if (Number(row.canceled)) return "canceled";
  return String(row.receivedDate ?? "").trim() ? "finished" : "pending";
}

/** Recebido − sem taxa (só FINALIZADO; ≠ 0 = "RECEBIDO COM DIFERENÇA"). */
export function creditSaleDifference(row: { canceled?: unknown; receivedDate?: unknown; receivedCents?: unknown; netCents?: unknown }): number {
  return creditSaleStatus(row) === "finished" ? Number(row.receivedCents || 0) - Number(row.netCents || 0) : 0;
}

export const SUGGEST_MAX_POOL = 8;

export type PendingCreditSale = { id: string; providerId: string; netCents: number; saleDate: string };

/**
 * Quais crediários PENDENTES o depósito quita: (1) um com o valor sem taxa
 * igual ao depósito (o mais antigo); senão (2) a menor combinação de 2+
 * crediários da MESMA financeira que soma o depósito. Com a financeira
 * identificada pelo texto do extrato, só os dela. [] = nenhuma sugestão.
 */
export function suggestCreditSalesForDeposit(depositCents: number, pending: PendingCreditSale[], providerId = ""): string[] {
  const ordered = pending
    .filter((sale) => !providerId || sale.providerId === providerId)
    .sort((a, b) => a.saleDate.localeCompare(b.saleDate) || a.id.localeCompare(b.id));
  const exact = ordered.find((sale) => sale.netCents === depositCents);
  if (exact) return [exact.id];
  for (const provider of new Set(ordered.map((sale) => sale.providerId))) {
    // ponytail: só os 8 pendentes mais antigos da financeira (255 combinações);
    // aumentar SUGGEST_MAX_POOL se um depósito juntar crediários mais espalhados.
    const pool = ordered.filter((sale) => sale.providerId === provider).slice(0, SUGGEST_MAX_POOL);
    let best: string[] = [];
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const picked = pool.filter((_, index) => mask & (1 << index));
      if (picked.length < 2 || (best.length && picked.length >= best.length)) continue;
      if (picked.reduce((sum, sale) => sum + sale.netCents, 0) === depositCents) best = picked.map((sale) => sale.id);
    }
    if (best.length) return best;
  }
  return [];
}

// Observação automática do depósito (a diferença fica registrada no
// crediário); VOLTAR PARA PENDENTE tira só essa linha.
export const DEPOSIT_NOTE_PREFIX = "[DEPÓSITO]";

export function withDepositNote(notes: string, text: string): string {
  return [withoutDepositNote(notes), `${DEPOSIT_NOTE_PREFIX} ${text}`].filter(Boolean).join("\n");
}

export function withoutDepositNote(notes: string): string {
  return String(notes || "")
    .split("\n")
    .filter((line) => !line.startsWith(DEPOSIT_NOTE_PREFIX))
    .join("\n")
    .trim();
}
