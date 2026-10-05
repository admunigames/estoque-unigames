import { ASSISTANCE_COMPANY_ID } from "../../../lib/card-fees";
import { machineCompanyAt, matchCardMachine, type MachineForMatch, type MachineTransfer } from "../../../lib/card-machines";
import { addDays } from "../../../lib/finance-status";
import {
  depositMatchesKeyword,
  expectedDeposits,
  matchDepositsToSales,
  PAYMENT_METHODS,
  resolveRevenueCompany,
  type DepositLine,
  type ExpectedLine,
  type PaymentMethod,
  type SaleKind,
} from "../../../lib/sales-recon";
import type { Database } from "../card-fees/shared";

// Conciliação de Vendas (Financeiro 6/9) — partes com SQL compartilhadas
// pelas rotas de app/api/finance/sales-recon/*. A regra pura fica em
// app/lib/sales-recon.ts.

function plainName(value: string): string {
  return value.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9]/g, "");
}

/** Loja do Ponttie pelo nome/id do arquivo: igual, ou um contém o outro (sem ambiguidade). */
export function resolveCompany(companies: { id: string; name: string }[], text: string): string {
  const wanted = plainName(text);
  if (!wanted) return "";
  const byId = companies.find((c) => c.id === text.trim());
  if (byId) return byId.id;
  const exact = companies.find((c) => plainName(c.name) === wanted);
  if (exact) return exact.id;
  const partial = companies.filter((c) => {
    const name = plainName(c.name);
    return name && (name.includes(wanted) || wanted.includes(name));
  });
  return partial.length === 1 ? partial[0].id : "";
}

export const RECON_STATUSES = ["pending", "matched", "divergent", "not_found", "ignored"] as const;

export function monthRange(month: string): { from: string; to: string } {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

type Machine = MachineForMatch & { companyName: string; label: string };
type CardSale = { id: string; companyId: string; machineId: string; saleDate: string; grossCents: number; nsu: string };
type BankCredit = { id: string; entryDate: string; amountCents: number };

export type MatchContext = {
  machines: Machine[];
  transfers: Map<string, MachineTransfer[]>;
  cardSales: CardSale[];
  bankCredits: BankCredit[];
  usedCardSales: Set<string>;
  usedBankEntries: Set<string>;
};

/**
 * Carrega o que o casamento precisa para as vendas entre from e to:
 * maquinetas (+ transferências), vendas da maquineta do período e créditos
 * do extrato (±1 dia, para o PIX), e o que já está casado com outra linha
 * (uma venda da maquineta / um crédito só casa com UMA linha do Ponttie).
 */
export async function loadMatchContext(
  database: Database,
  range: { from: string; to: string },
  excludeRowIds: string[] = [],
): Promise<MatchContext> {
  const [machines, events, cardSales, bankCredits, used] = await Promise.all([
    database
      .prepare(
        `SELECT id, terminal, serial, establishment_code AS establishmentCode, company_id AS companyId,
                company_name AS companyName,
                acquirer_name || ' ' || model || ' ' || CASE WHEN terminal <> '' THEN terminal ELSE serial END AS label
         FROM finance_card_machines`,
      )
      .all<Machine>(),
    database
      .prepare(
        `SELECT machine_id AS machineId, event_date AS eventDate, from_company_id AS fromCompanyId,
                from_company_name AS fromCompanyName
         FROM finance_card_machine_events WHERE kind='transfer'`,
      )
      .all<MachineTransfer & { machineId: string }>(),
    database
      .prepare(
        `SELECT id, company_id AS companyId, machine_id AS machineId, sale_date AS saleDate,
                gross_cents AS grossCents, nsu
         FROM finance_card_sales WHERE sale_date >= ?1 AND sale_date <= ?2`,
      )
      .bind(range.from, range.to)
      .all<CardSale>(),
    database
      .prepare(
        `SELECT id, entry_date AS entryDate, amount_cents AS amountCents
         FROM finance_bank_statement_entries
         WHERE amount_cents > 0 AND status <> 'credit_sale' AND entry_date >= ?1 AND entry_date <= ?2`,
      )
      .bind(addDays(range.from, -1), addDays(range.to, 1))
      .all<BankCredit>(),
    database
      .prepare(
        `SELECT id, card_sale_id AS cardSaleId, bank_entry_id AS bankEntryId FROM finance_sales_recon_rows
         WHERE card_sale_id <> '' OR bank_entry_id <> ''`,
      )
      .all<{ id: string; cardSaleId: string; bankEntryId: string }>(),
  ]);
  const transfers = new Map<string, MachineTransfer[]>();
  for (const event of events.results ?? []) {
    transfers.set(event.machineId, [...(transfers.get(event.machineId) ?? []), event]);
  }
  const excluded = new Set(excludeRowIds);
  const usedRows = (used.results ?? []).filter((row) => !excluded.has(row.id));
  return {
    machines: machines.results ?? [],
    transfers,
    cardSales: (cardSales.results ?? []).map((row) => ({ ...row, grossCents: Number(row.grossCents) })),
    bankCredits: (bankCredits.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents) })),
    usedCardSales: new Set(usedRows.map((row) => row.cardSaleId).filter(Boolean)),
    usedBankEntries: new Set(usedRows.map((row) => row.bankEntryId).filter(Boolean)),
  };
}

export type MatchInput = {
  companyId: string;
  saleDate: string;
  paymentMethod: PaymentMethod;
  amountCents: number;
  authorizationCode: string;
  terminalRef: string;
  kind: SaleKind;
  /** Maquineta já definida (manual) — usada quando o casamento não acha outra. */
  machineId?: string;
};

export type MatchResult = {
  machineId: string;
  machineLabel: string;
  cardSaleId: string;
  bankEntryId: string;
  status: "pending" | "matched" | "divergent" | "not_found";
  revenueCompanyId: string;
};

/**
 * Casa UMA linha do Ponttie e marca o que usou no contexto:
 * - cartão: maquineta pelo terminal; venda da maquineta por data + valor
 *   (+ NSU/autorização), primeiro na mesma loja (e maquineta) e depois em
 *   qualquer loja. Achou com valor igual = CONCILIADA; achou pelo NSU com
 *   valor diferente = DIVERGENTE; não achou = NÃO ENCONTRADA;
 * - PIX: crédito no extrato de mesmo valor em ±1 dia = CONCILIADA;
 * - dinheiro/outros: sem conciliação (pending).
 * A unidade do faturamento sai de resolveRevenueCompany com a unidade da
 * maquineta NA DATA da venda.
 */
export function matchReconRow(ctx: MatchContext, row: MatchInput): MatchResult {
  let machine = matchCardMachine(ctx.machines, [row.terminalRef]) ?? ctx.machines.find((m) => m.id === row.machineId) ?? null;
  let cardSaleId = "";
  let bankEntryId = "";
  let status: MatchResult["status"] = "pending";
  const isCard = row.paymentMethod === "debit" || row.paymentMethod === "credit";
  if (isCard) {
    const free = ctx.cardSales.filter((sale) => !ctx.usedCardSales.has(sale.id) && sale.saleDate === row.saleDate);
    const byNsu = row.authorizationCode ? free.filter((sale) => sale.nsu && sale.nsu === row.authorizationCode) : [];
    const sameValue = (byNsu.length ? byNsu : free).filter((sale) => sale.grossCents === row.amountCents);
    const rank = (sale: CardSale) => (machine && sale.machineId === machine.id ? 0 : sale.companyId === row.companyId ? 1 : 2);
    const found = [...sameValue].sort((a, b) => rank(a) - rank(b))[0] ?? byNsu[0];
    if (found) {
      cardSaleId = found.id;
      ctx.usedCardSales.add(found.id);
      status = found.grossCents === row.amountCents ? "matched" : "divergent";
      if (found.machineId) machine = ctx.machines.find((m) => m.id === found.machineId) ?? machine;
    } else {
      status = "not_found";
    }
  } else if (row.paymentMethod === "pix") {
    const window = [addDays(row.saleDate, -1), row.saleDate, addDays(row.saleDate, 1)];
    const credit = ctx.bankCredits
      .filter((entry) => !ctx.usedBankEntries.has(entry.id) && entry.amountCents === row.amountCents && window.includes(entry.entryDate))
      .sort((a, b) => Number(a.entryDate !== row.saleDate) - Number(b.entryDate !== row.saleDate))[0];
    if (credit) {
      bankEntryId = credit.id;
      ctx.usedBankEntries.add(credit.id);
      status = "matched";
    }
  }
  const machineCompanyId = machine
    ? machineCompanyAt(machine, ctx.transfers.get(machine.id) ?? [], row.saleDate).companyId
    : "";
  return {
    machineId: machine?.id ?? "",
    machineLabel: machine?.label ?? "",
    cardSaleId,
    bankEntryId,
    status,
    revenueCompanyId: resolveRevenueCompany({
      kind: row.kind,
      paymentMethod: row.paymentMethod,
      machineCompanyId,
      saleCompanyId: row.companyId,
    }),
  };
}

// ---------------------------------------------------------------------------
// CARTÃO × BANCO
// ---------------------------------------------------------------------------

type AcquirerRow = { id: string; name: string; debitDays: number; creditDays: number; anticipated: number; bankKeyword: string };
type CardSaleForDeposit = {
  id: string;
  companyId: string;
  acquirerId: string;
  saleDate: string;
  modality: string;
  installments: number;
  grossCents: number;
  netCents: number;
  expectedFeeCents: number;
  chargedFeeCents: number | null;
  reviewedAt: string;
};
type EntryRow = { id: string; entryDate: string; description: string; amountCents: number; salesReconStatus: string; salesReconNote: string; companyId: string };

/**
 * Dias de depósito de [from, to]: parcelas esperadas das vendas da
 * maquineta (líquido = bruto − taxa cobrada, ou a cadastrada) × créditos do
 * extrato com o bank_keyword da adquirente. companyId '' = todas as lojas.
 */
export async function loadDepositDays(
  database: Database,
  input: { from: string; to: string; companyId: string; today: string },
) {
  const acquirers = ((await database
    .prepare(
      `SELECT id, name, debit_days AS debitDays, credit_days AS creditDays, anticipated, bank_keyword AS bankKeyword
       FROM finance_acquirers`,
    )
    .all<AcquirerRow>()).results ?? []).map((row) => ({
    ...row,
    debitDays: Number(row.debitDays ?? 1),
    creditDays: Number(row.creditDays ?? 30),
    anticipated: Number(row.anticipated) === 1,
  }));
  const byId = new Map(acquirers.map((row) => [row.id, row]));
  // Venda à vista/débito deposita em poucos dias; parcelada pode depositar
  // até 12 × prazo depois — só ela entra na janela longa.
  const shortBack = Math.max(1, ...acquirers.map((row) => Math.max(row.debitDays, row.creditDays))) + 1;
  const longBack = Math.min(400, Math.max(...acquirers.map((row) => row.creditDays), 30) * 12 + 1);
  const saleValues: unknown[] = [input.to, addDays(input.from, -shortBack), addDays(input.from, -longBack)];
  if (input.companyId) saleValues.push(input.companyId);
  const sales = ((await database
    .prepare(
      `SELECT id, company_id AS companyId, acquirer_id AS acquirerId, sale_date AS saleDate, modality, installments,
              gross_cents AS grossCents, net_cents AS netCents, expected_fee_cents AS expectedFeeCents,
              charged_fee_cents AS chargedFeeCents, reviewed_at AS reviewedAt
       FROM finance_card_sales
       WHERE sale_date <= ?1 AND (sale_date >= ?2 OR (sale_date >= ?3 AND modality = 'credit' AND installments > 1))
         ${input.companyId ? "AND company_id = ?4" : ""}`,
    )
    .bind(...saleValues)
    .all<CardSaleForDeposit>()).results ?? []);
  const expected: ExpectedLine[] = [];
  const saleById = new Map<string, CardSaleForDeposit & { parcels: number }>();
  for (const sale of sales) {
    const acquirer = byId.get(sale.acquirerId);
    if (!acquirer) continue;
    const charged = sale.chargedFeeCents === null || sale.chargedFeeCents === undefined ? null : Number(sale.chargedFeeCents);
    const net = Number(sale.grossCents) - (charged ?? Number(sale.expectedFeeCents));
    const lines = expectedDeposits({
      saleDate: sale.saleDate,
      modality: sale.modality,
      installments: Number(sale.installments),
      netCents: net,
      terms: { debitDays: acquirer.debitDays, creditDays: acquirer.creditDays, anticipated: acquirer.anticipated },
    });
    saleById.set(sale.id, { ...sale, parcels: lines.length });
    for (const line of lines) {
      if (line.date >= input.from && line.date <= input.to) {
        expected.push({ saleId: sale.id, acquirerId: sale.acquirerId, date: line.date, netCents: line.netCents });
      }
    }
  }

  const keyed = acquirers.filter((row) => row.bankKeyword.trim());
  const entries = ((await database
    .prepare(
      `SELECT id, entry_date AS entryDate, description, amount_cents AS amountCents,
              sales_recon_status AS salesReconStatus, sales_recon_note AS salesReconNote, company_id AS companyId
       FROM finance_bank_statement_entries
       WHERE amount_cents > 0 AND entry_date >= ?1 AND entry_date <= ?2 ${input.companyId ? "AND company_id = ?3" : ""}`,
    )
    .bind(...[input.from, input.to, ...(input.companyId ? [input.companyId] : [])])
    .all<EntryRow>()).results ?? []);
  const entryById = new Map<string, EntryRow>();
  const deposits: DepositLine[] = [];
  for (const entry of entries) {
    const acquirer = keyed.find((row) => depositMatchesKeyword(entry.description, row.bankKeyword));
    if (!acquirer) continue;
    entryById.set(entry.id, entry);
    deposits.push({
      entryId: entry.id,
      acquirerId: acquirer.id,
      date: entry.entryDate,
      amountCents: Number(entry.amountCents),
      reviewed: entry.salesReconStatus === "reviewed",
    });
  }
  return {
    days: matchDepositsToSales(expected, deposits, input.today),
    acquirers,
    saleById,
    entryById,
  };
}

// ---------------------------------------------------------------------------
// RESUMO DO MÊS / FATURAMENTO
// ---------------------------------------------------------------------------

type SummaryRow = { revenueCompanyId: string; kind: string; paymentMethod: string; amountCents: number; status: string };

export function summarizeRevenueUnits(rows: SummaryRow[]) {
  const units = new Map<string, { companyId: string; salesCents: number; servicesCents: number; byMethod: Record<string, number> }>();
  for (const row of rows) {
    if (row.status === "ignored") continue;
    const unit = units.get(row.revenueCompanyId) ?? {
      companyId: row.revenueCompanyId,
      salesCents: 0,
      servicesCents: 0,
      byMethod: Object.fromEntries(PAYMENT_METHODS.map((method) => [method, 0])),
    };
    const amount = Number(row.amountCents);
    if (row.kind === "service") unit.servicesCents += amount;
    else unit.salesCents += amount;
    unit.byMethod[row.paymentMethod] = (unit.byMethod[row.paymentMethod] ?? 0) + amount;
    units.set(row.revenueCompanyId, unit);
  }
  return [...units.values()].sort(
    (a, b) => Number(a.companyId === ASSISTANCE_COMPANY_ID) - Number(b.companyId === ASSISTANCE_COMPANY_ID),
  );
}

/**
 * Linhas do mês que entram no faturamento, no escopo do login: quem vê todas
 * as lojas vê todas as unidades (inclusive ASSISTÊNCIA); login com loja só o
 * que entra na própria loja.
 */
export async function loadRevenueRows(database: Database, month: string, scopeCompanyId: string) {
  const { from, to } = monthRange(month);
  const result = await database
    .prepare(
      `SELECT revenue_company_id AS revenueCompanyId, kind, payment_method AS paymentMethod,
              amount_cents AS amountCents, status
       FROM finance_sales_recon_rows
       WHERE sale_date >= ?1 AND sale_date <= ?2 ${scopeCompanyId ? "AND revenue_company_id = ?3" : ""}`,
    )
    .bind(...[from, to, ...(scopeCompanyId ? [scopeCompanyId] : [])])
    .all<SummaryRow>();
  return result.results ?? [];
}

/**
 * Faturamento ATUAL (finance_store_revenue) × NOVO (Ponttie conciliado) por
 * unidade que tem vendas no mês. Unidade sem linhas não entra (não é zerada).
 */
export async function buildRevenuePlan(database: Database, month: string, scopeCompanyId: string) {
  const units = summarizeRevenueUnits(await loadRevenueRows(database, month, scopeCompanyId));
  const current = units.length
    ? await database
        .prepare(
          `SELECT id, store_id AS storeId, sales_amount_cents AS salesCents, services_amount_cents AS servicesCents,
                  updated_by_name AS updatedByName, updated_at AS updatedAt
           FROM finance_store_revenue WHERE month=?1 AND store_id IN (${units.map((_, i) => `?${i + 2}`).join(",")})`,
        )
        .bind(month, ...units.map((unit) => unit.companyId))
        .all<{ id: string; storeId: string; salesCents: number; servicesCents: number; updatedByName: string; updatedAt: string }>()
    : { results: [] };
  const byStore = new Map((current.results ?? []).map((row) => [row.storeId, row]));
  return units.map((unit) => {
    const existing = byStore.get(unit.companyId);
    return {
      ...unit,
      revenueId: existing?.id ?? null,
      currentSalesCents: Number(existing?.salesCents ?? 0),
      currentServicesCents: Number(existing?.servicesCents ?? 0),
      currentUpdatedByName: existing?.updatedByName ?? "",
      currentUpdatedAt: existing?.updatedAt ?? "",
    };
  });
}
