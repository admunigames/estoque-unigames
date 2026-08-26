// Regras de status/divergência de Recebíveis (Financeiro Fase 6).
//
// Mesmo princípio de app/lib/finance-status.ts: nada que dê pra derivar de
// data/valor é persistido. O banco (accounts_receivable) só guarda o que
// depende de uma AÇÃO do usuário — o cancelamento e o registro do valor
// efetivamente recebido; "pendente", "vencido", "recebido ok" e "recebido
// divergente" saem daqui.
//
// Módulo próprio (e não uma extensão de finance-status.ts) por coesão: os
// estados e a regra de tolerância não têm nada em comum com o ciclo de vida
// de uma conta a pagar (parcial/agendado/pago), e finance-status.ts já é
// importado por várias rotas que não têm nada a ver com Recebíveis.

export type ReceivableDisplayStatus =
  | "pending" // ainda não recebido, data prevista hoje ou no futuro
  | "overdue" // ainda não recebido e a data prevista já passou
  | "received_ok" // recebido dentro da tolerância
  | "received_divergent" // recebido fora da tolerância
  | "canceled";

export const RECEIVABLE_STATUS_LABELS: Record<ReceivableDisplayStatus, string> = {
  pending: "PENDENTE",
  overdue: "ATRASADO",
  received_ok: "RECEBIDO",
  received_divergent: "RECEBIDO COM DIVERGÊNCIA",
  canceled: "CANCELADO",
};

export type ReceivablesTolerance = {
  /** Percentual em basis points (200 = 2%). */
  toleranceBps: number;
  /** Valor fixo em centavos (2000 = R$20,00). */
  toleranceFixedCents: number;
};

/**
 * Diferença entre o recebido e o previsto. NULL quando ainda não houve
 * recebimento (nunca 0 nesse caso — 0 significa "recebeu exatamente o
 * previsto", que é uma informação diferente de "ainda não recebeu").
 */
export function receivableDifferenceCents(
  expectedAmountCents: number,
  receivedAmountCents: number | null | undefined,
): number | null {
  if (receivedAmountCents === null || receivedAmountCents === undefined) return null;
  return Number(receivedAmountCents) - Number(expectedAmountCents);
}

/**
 * Divergência = a diferença absoluta estourou o limite percentual OU o limite
 * de valor fixo — o que for atingido PRIMEIRO (decisão confirmada com o
 * usuário). Usar ">" (e não ">=") mantém o limiar configurado como valor
 * ainda tolerado.
 */
export function isReceivableDivergent(params: {
  expectedAmountCents: number;
  receivedAmountCents: number | null | undefined;
  tolerance: ReceivablesTolerance;
}): boolean {
  const difference = receivableDifferenceCents(params.expectedAmountCents, params.receivedAmountCents);
  if (difference === null) return false;
  const absolute = Math.abs(difference);
  const percentLimit = Math.abs(Number(params.expectedAmountCents)) * (params.tolerance.toleranceBps / 10000);
  return absolute > params.tolerance.toleranceFixedCents || absolute > percentLimit;
}

export function computeReceivableDisplayStatus(params: {
  canceled: boolean;
  expectedDate: string;
  expectedAmountCents: number;
  receivedAmountCents: number | null | undefined;
  tolerance: ReceivablesTolerance;
  today: string;
}): ReceivableDisplayStatus {
  if (params.canceled) return "canceled";
  if (params.receivedAmountCents === null || params.receivedAmountCents === undefined) {
    return params.expectedDate < params.today ? "overdue" : "pending";
  }
  return isReceivableDivergent(params) ? "received_divergent" : "received_ok";
}

/**
 * Mesma precedência de computeReceivableDisplayStatus, escrita como expressão
 * SQL (CASE), pra filtrar/ordenar no banco sem carregar todas as linhas em JS
 * — mesma técnica de displayStatusCaseSql em app/lib/payables-recurrence.ts.
 *
 * Os três parâmetros vêm sempre por bind (nunca interpolados): "hoje"
 * (YYYY-MM-DD), a tolerância em basis points e a tolerância fixa em centavos.
 */
export function receivableStatusCaseSql(
  todayParamIndex: number,
  toleranceBpsParamIndex: number,
  toleranceFixedParamIndex: number,
): string {
  const today = `?${todayParamIndex}`;
  const bps = `?${toleranceBpsParamIndex}`;
  const fixed = `?${toleranceFixedParamIndex}`;
  return `CASE
    WHEN canceled = 1 THEN 'canceled'
    WHEN received_amount_cents IS NULL AND expected_date < ${today} THEN 'overdue'
    WHEN received_amount_cents IS NULL THEN 'pending'
    WHEN ABS(received_amount_cents - expected_amount_cents) > ${fixed}::numeric
      OR ABS(received_amount_cents - expected_amount_cents) > ABS(expected_amount_cents) * (${bps}::numeric / 10000)
      THEN 'received_divergent'
    ELSE 'received_ok'
  END`;
}

export const RECEIVABLE_STATUSES: ReceivableDisplayStatus[] = [
  "pending",
  "overdue",
  "received_ok",
  "received_divergent",
  "canceled",
];

export function isReceivableStatus(value: string): value is ReceivableDisplayStatus {
  return (RECEIVABLE_STATUSES as string[]).includes(value);
}
