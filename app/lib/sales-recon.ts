// Lógica pura da Conciliação de Vendas (Financeiro 6/9). Sem I/O: forma de
// pagamento do Ponttie, VENDA × SERVIÇO, unidade do faturamento, prazo de
// recebimento por adquirente e o cruzamento CARTÃO × BANCO (depósitos do
// extrato × líquido esperado das vendas da maquineta). As rotas
// (app/api/finance/sales-recon/*) carregam as linhas e chamam estas funções.

import { ASSISTANCE_COMPANY_ID, feeOutsideTolerance } from "./card-fees";
import { addDays } from "./finance-status";

export const PAYMENT_METHODS = ["cash", "pix", "debit", "credit", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type SaleKind = "sale" | "service";

function plain(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** DINHEIRO → cash; PIX → pix; DÉBITO → debit; CRÉDITO/PARCELADO → credit; resto → other. */
export function normalizePaymentMethod(value: unknown): PaymentMethod {
  const text = plain(value);
  if (/DINHEIRO|ESPECIE|\bCASH\b/.test(text)) return "cash";
  if (/\bPIX\b/.test(text)) return "pix";
  if (/DEBITO/.test(text)) return "debit";
  if (/CREDITO|PARCELADO|\bCARTAO\b/.test(text)) return "credit";
  return "other";
}

// Palavras que marcam SERVIÇO (sem acento, em CAIXA ALTA). Ajustar aqui.
// "OS" sozinho só vale na coluna TIPO/CATEGORIA — na descrição ele é artigo
// ("KIT COM OS CONTROLES"); "O.S." vale em qualquer coluna.
export const SERVICE_KEYWORDS = ["SERVICO", "O.S.", "MANUTENCAO", "REPARO", "CONSERTO", "LIMPEZA", "TROCA DE"];

export function classifySaleKind(row: {
  type?: unknown;
  description?: unknown;
  serviceOrder?: unknown;
}): SaleKind {
  if (plain(row.serviceOrder).trim()) return "service";
  const type = plain(row.type);
  const text = `${type} ${plain(row.description)}`;
  if (SERVICE_KEYWORDS.some((word) => text.includes(word))) return "service";
  return /\bOS\b/.test(type) ? "service" : "sale";
}

/**
 * Onde o valor entra no faturamento: SERVIÇO → ASSISTÊNCIA (qualquer que seja
 * a maquineta); VENDA no cartão com maquineta → unidade da maquineta NA DATA
 * (quem chama já resolveu com machineCompanyAt); senão → loja do Ponttie.
 */
export function resolveRevenueCompany(input: {
  kind: SaleKind;
  paymentMethod: PaymentMethod;
  machineCompanyId: string;
  saleCompanyId: string;
}): string {
  if (input.kind === "service") return ASSISTANCE_COMPANY_ID;
  if ((input.paymentMethod === "debit" || input.paymentMethod === "credit") && input.machineCompanyId) {
    return input.machineCompanyId;
  }
  return input.saleCompanyId;
}

export type AcquirerTerms = { debitDays: number; creditDays: number; anticipated: boolean };

/**
 * Datas e valores esperados no banco para uma venda da maquineta: débito em
 * D+debitDays; crédito antecipado tudo em D+1; crédito normal uma parcela
 * por vez em D + creditDays × nº da parcela (último centavo na última).
 * ponytail: dias corridos — depósito que cai no fim de semana vai para o dia
 * útil seguinte e aparece como DIVERGENTE/NÃO DEPOSITADO; trocar por dias
 * úteis se isso incomodar.
 */
export function expectedDeposits(input: {
  saleDate: string;
  modality: string;
  installments: number;
  netCents: number;
  terms: AcquirerTerms;
}): Array<{ date: string; netCents: number }> {
  if (input.modality === "debit" || input.modality === "pix") {
    return [{ date: addDays(input.saleDate, Math.max(0, input.terms.debitDays)), netCents: input.netCents }];
  }
  if (input.terms.anticipated) return [{ date: addDays(input.saleDate, 1), netCents: input.netCents }];
  const parcels = Math.max(1, Math.round(input.installments || 1));
  const each = Math.floor(input.netCents / parcels);
  return Array.from({ length: parcels }, (_, index) => ({
    date: addDays(input.saleDate, Math.max(0, input.terms.creditDays) * (index + 1)),
    netCents: index === parcels - 1 ? input.netCents - each * (parcels - 1) : each,
  }));
}

export type ExpectedLine = { saleId: string; acquirerId: string; date: string; netCents: number };
export type DepositLine = { entryId: string; acquirerId: string; date: string; amountCents: number; reviewed?: boolean };
export type DepositDayStatus = "ok" | "divergent" | "deposit_without_sale" | "awaiting" | "not_deposited" | "reviewed";
export type DepositDay = {
  key: string;
  acquirerId: string;
  date: string;
  expectedCents: number;
  depositedCents: number;
  differenceCents: number;
  status: DepositDayStatus;
  expected: ExpectedLine[];
  deposits: DepositLine[];
};

/**
 * CARTÃO × BANCO por adquirente e DIA DE DEPÓSITO: esperado (líquido das
 * parcelas previstas para o dia) × depositado (créditos do extrato com o
 * texto da adquirente). OK dentro da mesma tolerância das taxas, aplicada ao
 * total do dia. Sem venda esperada = DEPÓSITO SEM VENDA; sem depósito =
 * AGUARDANDO (data de hoje em diante) ou NÃO DEPOSITADO. Dia com todos os
 * depósitos revisados = REVISADO.
 */
export function matchDepositsToSales(expected: ExpectedLine[], deposits: DepositLine[], today: string): DepositDay[] {
  const days = new Map<string, DepositDay>();
  const dayOf = (acquirerId: string, date: string) => {
    const key = `${acquirerId}|${date}`;
    let day = days.get(key);
    if (!day) {
      day = { key, acquirerId, date, expectedCents: 0, depositedCents: 0, differenceCents: 0, status: "ok", expected: [], deposits: [] };
      days.set(key, day);
    }
    return day;
  };
  for (const line of expected) {
    const day = dayOf(line.acquirerId, line.date);
    day.expected.push(line);
    day.expectedCents += line.netCents;
  }
  for (const line of deposits) {
    const day = dayOf(line.acquirerId, line.date);
    day.deposits.push(line);
    day.depositedCents += line.amountCents;
  }
  for (const day of days.values()) {
    day.differenceCents = day.depositedCents - day.expectedCents;
    if (day.deposits.length && day.deposits.every((line) => line.reviewed)) day.status = "reviewed";
    else if (!day.expected.length) day.status = "deposit_without_sale";
    else if (!day.deposits.length) day.status = day.date >= today ? "awaiting" : "not_deposited";
    else day.status = feeOutsideTolerance(day.expectedCents, day.differenceCents) ? "divergent" : "ok";
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.acquirerId.localeCompare(b.acquirerId));
}

/**
 * Rateia o depositado no dia entre as vendas esperadas, proporcional ao
 * líquido esperado; a sobra de arredondamento vai para a maior venda.
 */
export function allocateDeposit(totalCents: number, lines: Array<{ id: string; netCents: number }>): Map<string, number> {
  const result = new Map<string, number>();
  if (!lines.length) return result;
  const base = lines.reduce((sum, line) => sum + line.netCents, 0);
  let used = 0;
  for (const line of lines) {
    const share = base ? Math.floor((totalCents * line.netCents) / base) : Math.floor(totalCents / lines.length);
    result.set(line.id, (result.get(line.id) ?? 0) + share);
    used += share;
  }
  const largest = lines.reduce((best, line) => (line.netCents > best.netCents ? line : best), lines[0]);
  result.set(largest.id, (result.get(largest.id) ?? 0) + totalCents - used);
  return result;
}

/** O texto da adquirente aparece na descrição (sem acento, caixa, espaço ou pontuação). */
export function depositMatchesKeyword(description: string, keyword: string): boolean {
  const squash = (value: string) => plain(value).replace(/[^A-Z0-9]/g, "");
  const key = squash(keyword);
  return Boolean(key) && squash(description).includes(key);
}
