// Relatório COMISSIONAMENTO / HORAS / PREMIAÇÃO para a contabilidade (RH,
// 22/10/2026; colunas simplificadas em 23/10/2026) — lógica pura, sem banco.
//
// Regras do usuário:
//  - DESCONTO sempre na COMISSÃO, nunca na premiação. Se o desconto (do mês +
//    a sobra do mês anterior) passar da comissão, a comissão fica 0 e a SOBRA
//    vai para o MÊS SEGUINTE — aparece no relatório dos dois meses.
//  - PREMIAÇÃO separada da comissão (Comercial + premiações do RH).
//  - HORAS EXTRAS A PAGAR em três tipos (HE 50%, HE 100%, ADICIONAL NOTURNO):
//    quantidade + valor da hora (salário ÷ 220 × fator, editável). HE 50% +
//    HE 100% abatem o banco de horas; o adicional noturno não é hora extra e
//    não abate.

export const MONTHLY_HOURS = 220;

export const OVERTIME_KINDS = [
  { key: "he50", label: "HE 50%", factor: 1.5 },
  { key: "he100", label: "HE 100%", factor: 2 },
  { key: "night", label: "ADICIONAL NOTURNO", factor: 0.2 },
] as const;

export type OvertimeKind = (typeof OVERTIME_KINDS)[number]["key"];
export type OvertimeLine = { minutes: number; rateCents: number };
export type OvertimeInput = Record<OvertimeKind, OvertimeLine>;
export type OvertimeResult = Record<OvertimeKind, OvertimeLine & { amountCents: number }> & { totalCents: number };

const int = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));

/** Valor da hora sugerido: salário ÷ 220 × fator (centavos). */
export function suggestedHourlyRateCents(salaryCents: number, kind: OvertimeKind): number {
  const factor = OVERTIME_KINDS.find((item) => item.key === kind)?.factor ?? 0;
  return Math.round((int(salaryCents) / MONTHLY_HOURS) * factor);
}

/** R$ de uma linha: horas (minutos ÷ 60) × valor da hora. */
export function overtimeAmountCents(minutes: number, rateCents: number): number {
  return Math.round((int(minutes) / 60) * int(rateCents));
}

export function computeOvertime(input: Partial<OvertimeInput>): OvertimeResult {
  const result = { totalCents: 0 } as OvertimeResult;
  for (const { key } of OVERTIME_KINDS) {
    const line = input[key] ?? { minutes: 0, rateCents: 0 };
    const minutes = int(line.minutes);
    const rateCents = int(line.rateCents);
    const amountCents = overtimeAmountCents(minutes, rateCents);
    result[key] = { minutes, rateCents, amountCents };
    result.totalCents += amountCents;
  }
  return result;
}

/** Minutos que abatem o banco de horas: só as horas extras (50% e 100%). */
export function bankPaidMinutes(input: Partial<OvertimeInput>): number {
  return int(input.he50?.minutes) + int(input.he100?.minutes);
}

export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
}

export type CommissionMonth = { month: string; commissionCents: number; discountCents: number };
export type CommissionCarry = {
  month: string;
  commissionCents: number;
  /** Descontos lançados no mês. */
  discountCents: number;
  /** Sobra do mês anterior (desconto que não coube na comissão). */
  carryInCents: number;
  /** Quanto do desconto (mês + sobra) foi abatido da comissão. */
  appliedCents: number;
  netCommissionCents: number;
  /** Sobra que vai para o mês seguinte. */
  carryOutCents: number;
};

/**
 * Corrente de sobras de desconto, mês a mês (meses sem lançamento também
 * recebem a sobra). `history` em qualquer ordem; devolve do primeiro mês do
 * histórico até `untilMonth`, inclusive.
 */
export function commissionCarryChain(history: CommissionMonth[], untilMonth: string): Map<string, CommissionCarry> {
  const byMonth = new Map<string, CommissionMonth>();
  for (const row of history) {
    const current = byMonth.get(row.month);
    byMonth.set(row.month, {
      month: row.month,
      commissionCents: (current?.commissionCents ?? 0) + Math.round(Number(row.commissionCents) || 0),
      discountCents: (current?.discountCents ?? 0) + int(row.discountCents),
    });
  }
  const result = new Map<string, CommissionCarry>();
  const months = [...byMonth.keys()].filter((month) => month <= untilMonth).sort();
  if (!months.length) return result;
  let carry = 0;
  for (let month = months[0]; month <= untilMonth; month = nextMonth(month)) {
    const row = byMonth.get(month);
    const commissionCents = Math.max(0, row?.commissionCents ?? 0);
    const discountCents = row?.discountCents ?? 0;
    const owed = discountCents + carry;
    const appliedCents = Math.min(owed, commissionCents);
    const carryOutCents = owed - appliedCents;
    result.set(month, {
      month,
      commissionCents,
      discountCents,
      carryInCents: carry,
      appliedCents,
      netCommissionCents: commissionCents - appliedCents,
      carryOutCents,
    });
    carry = carryOutCents;
  }
  return result;
}

export type AccountingPerson = {
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  cnpj: string;
  /** Comissão do mês com o desconto aplicado (e a sobra do mês anterior). */
  carry: CommissionCarry;
  premiumCents: number;
  /** HORAS EXTRAS do mês: valor ÚNICO em R$ digitado à mão (23/10/2026). */
  overtimeCents: number;
};

export type AccountingRow = AccountingPerson & { totalCents: number };

export type AccountingTotals = {
  commissionCents: number;
  premiumCents: number;
  overtimeCents: number;
  totalCents: number;
};

export type AccountingGroup = { cnpj: string; companyNames: string[]; rows: AccountingRow[]; subtotal: AccountingTotals };

function emptyTotals(): AccountingTotals {
  return { commissionCents: 0, premiumCents: 0, overtimeCents: 0, totalCents: 0 };
}

function addRow(totals: AccountingTotals, row: AccountingRow) {
  totals.commissionCents += row.carry.netCommissionCents;
  totals.premiumCents += row.premiumCents;
  totals.overtimeCents += row.overtimeCents;
  totals.totalCents += row.totalCents;
}

/**
 * Relatório para a contabilidade (23/10/2026): só COMISSIONAMENTO (comissão
 * com o desconto aplicado), HORAS EXTRAS (valor único digitado à mão) e
 * PREMIAÇÃO, agrupado por EMPRESA (CNPJ do cadastro de Lojas; lojas sem CNPJ
 * ficam no grupo "SEM CNPJ"). TOTAL da linha = comissionamento + HE +
 * premiação. Linhas sem nenhum valor (nem sobra de desconto) ficam de fora.
 */
export function buildAccountingReport(people: AccountingPerson[]): { groups: AccountingGroup[]; total: AccountingTotals } {
  const groups = new Map<string, AccountingGroup>();
  const total = emptyTotals();
  for (const person of people) {
    const overtimeCents = Math.max(0, Math.round(Number(person.overtimeCents) || 0));
    const row: AccountingRow = {
      ...person,
      overtimeCents,
      totalCents: person.carry.netCommissionCents + person.premiumCents + overtimeCents,
    };
    // Sem valor nenhum fica de fora — mas a sobra de desconto aparece nos dois meses.
    const hasValue = row.carry.netCommissionCents || row.premiumCents || row.overtimeCents || row.carry.carryInCents || row.carry.carryOutCents;
    if (!hasValue) continue;
    let group = groups.get(person.cnpj);
    if (!group) {
      group = { cnpj: person.cnpj, companyNames: [], rows: [], subtotal: emptyTotals() };
      groups.set(person.cnpj, group);
    }
    if (person.companyName && !group.companyNames.includes(person.companyName)) group.companyNames.push(person.companyName);
    group.rows.push(row);
    addRow(group.subtotal, row);
    addRow(total, row);
  }
  const ordered = [...groups.values()].sort((a, b) => (!a.cnpj !== !b.cnpj ? (a.cnpj ? -1 : 1) : a.cnpj.localeCompare(b.cnpj)));
  for (const group of ordered) {
    group.companyNames.sort((a, b) => a.localeCompare(b, "pt-BR"));
    group.rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName, "pt-BR"));
  }
  return { groups: ordered, total };
}
