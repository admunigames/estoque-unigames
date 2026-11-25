// Controle de Reposição — saldo por conta de responsável (23/11/2026).
// Lógica pura (sem imports) para a rota e os testes usarem direto.
//
// Só dois tipos valem no lançamento: ENTRADA e SAÍDA. Os tipos antigos
// continuam gravados e entram no grupo certo: REPOSIÇÃO/RECUPERAÇÃO =
// ENTRADA; RESSARCIMENTO/PREJUÍZO = SAÍDA.
//
// Saldo de uma conta (responsável) no início do mês M = a base mais recente
// antes de M + entradas − saídas entre a base e M. Base = SALDO INICIAL
// (vale a partir do mês dele) ou o FECHAMENTO de um mês já finalizado (vale
// a partir do mês seguinte) — o que começar mais tarde. Sem base, parte de 0.

// OUTROS (ENTRADA) soma e OUTROS (SAÍDA) subtrai, como entrada/saída (25/11/2026).
export const INFLOW_KINDS = ["entrada", "reposicao", "recuperacao", "outros_entrada"];
export const OUTFLOW_KINDS = ["saida", "ressarcimento", "prejuizo", "outros_saida"];

export type BalanceEntry = { entryDate: string; amountCents: number; kind: string; responsibleName: string };
export type BalanceRow = { kind: "initial" | "closing" | string; month: string; responsibleName: string; amountCents: number };
export type BalanceSummary = { openingCents: number; inflowCents: number; outflowCents: number; closingCents: number };

export function kindGroup(kind: string): "entrada" | "saida" {
  return INFLOW_KINDS.includes(kind) ? "entrada" : "saida";
}

export function nextMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
}

const signed = (entry: BalanceEntry) => (kindGroup(entry.kind) === "entrada" ? 1 : -1) * Number(entry.amountCents || 0);

/** Saldo de UMA conta (responsável) entre os meses from..to (YYYY-MM, inclusive). */
export function accountBalance(entries: BalanceEntry[], balances: BalanceRow[], from: string, to: string): BalanceSummary {
  let base = 0;
  let baseStart = "0000-00";
  for (const row of balances) {
    const start = row.kind === "initial" ? row.month : row.kind === "closing" ? nextMonth(row.month) : "";
    if (!start || start > from || start < baseStart) continue;
    // Mesmo início: o fechamento do mês anterior vale sobre o saldo inicial.
    if (start === baseStart && row.kind === "initial") continue;
    base = Number(row.amountCents || 0);
    baseStart = start;
  }
  const summary: BalanceSummary = { openingCents: base, inflowCents: 0, outflowCents: 0, closingCents: 0 };
  for (const entry of entries) {
    const month = entry.entryDate.slice(0, 7);
    if (month >= baseStart && month < from) summary.openingCents += signed(entry);
    else if (month >= from && month <= to) {
      if (kindGroup(entry.kind) === "entrada") summary.inflowCents += Number(entry.amountCents || 0);
      else summary.outflowCents += Number(entry.amountCents || 0);
    }
  }
  summary.closingCents = summary.openingCents + summary.inflowCents - summary.outflowCents;
  return summary;
}

/** Saldo por responsável (e o total somado) — `responsible` filtra por parte do nome. */
export function replacementBalances(
  entries: BalanceEntry[],
  balances: BalanceRow[],
  from: string,
  to: string,
  responsible = "",
): { total: BalanceSummary; accounts: Array<BalanceSummary & { responsibleName: string }> } {
  const key = (name: string) => String(name || "").trim().toLocaleUpperCase("pt-BR");
  const filter = key(responsible);
  const names = [...new Set([...entries, ...balances].map((item) => key(item.responsibleName)))]
    .filter((name) => !filter || name.includes(filter))
    .sort();
  const accounts = names.map((name) => ({
    responsibleName: name,
    ...accountBalance(
      entries.filter((entry) => key(entry.responsibleName) === name),
      balances.filter((row) => key(row.responsibleName) === name),
      from,
      to,
    ),
  }));
  const total: BalanceSummary = { openingCents: 0, inflowCents: 0, outflowCents: 0, closingCents: 0 };
  for (const account of accounts) {
    total.openingCents += account.openingCents;
    total.inflowCents += account.inflowCents;
    total.outflowCents += account.outflowCents;
    total.closingCents += account.closingCents;
  }
  return { total, accounts };
}

/** Lançamentos repetidos: mesma data + mesmo valor + mesmo grupo (ENTRADA/SAÍDA). */
export function repeatedEntryIds(entries: Array<BalanceEntry & { id: string }>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const key = `${entry.entryDate}|${entry.amountCents}|${kindGroup(entry.kind)}`;
    groups.set(key, [...(groups.get(key) || []), entry.id]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
}
