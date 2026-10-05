// Lógica pura das Taxas de Cartão (Financeiro Fase 7). Sem I/O: resolução da
// taxa aplicável a uma venda, cálculo de líquido previsto / divergência e
// agregação do relatório mensal. As rotas (app/api/finance/card-fees/*,
// card-sales/*) carregam as linhas do banco e chamam estas funções.

export const CARD_MODALITIES = ["debit", "credit", "pix"] as const;
export type CardModality = (typeof CARD_MODALITIES)[number];

export function isCardModality(value: unknown): value is CardModality {
  return typeof value === "string" && (CARD_MODALITIES as readonly string[]).includes(value);
}

// ASSISTÊNCIA no Cadastro de Lojas (companies_list): separada das LOJAS no
// TOTAL DE TAXAS (e, no prompt 6, destino do faturamento de serviços).
export const ASSISTANCE_COMPANY_ID = "cmsf6alzkcw4wk";

export type CardFee = {
  id: string;
  acquirerId: string;
  /** '' = taxa da adquirente; preenchido = taxa própria da maquineta. */
  machineId?: string;
  /** '' = global; preenchido = só vale para vendas dessa unidade. */
  companyId?: string;
  brand: string;
  modality: string;
  installments: number;
  feeBps: number;
  anticipationBps: number;
  validFrom: string;
  validTo: string;
};

export type SaleKey = {
  acquirerId: string;
  brand: string;
  modality: string;
  installments: number;
  date: string;
  machineId?: string;
  companyId?: string;
};

function normalizeBrand(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Escolhe a taxa que se aplica a uma venda. Primeiro procura nas taxas
 * PRÓPRIAS da maquineta da venda; sem nenhuma que cubra, cai nas taxas da
 * adquirente (machine_id '', globais ou da unidade da venda). Em cada nível:
 * 1. Adquirente tem que bater exatamente.
 * 2. Modalidade tem que bater. Para crédito, o número de parcelas também.
 * 3. A vigência tem que cobrir a data da venda (valid_from <= data, e
 *    valid_to vazio OU >= data).
 * 4. Entre as candidatas, a de bandeira específica ganha da de bandeira
 *    curinga (''); depois a da unidade ganha da global; em empate, a de
 *    valid_from mais recente.
 * Devolve null quando nenhuma taxa cadastrada cobre a venda — a rota trata
 * isso como "taxa não encontrada" (a linha entra com fee 0 e é sinalizada).
 */
export function resolveCardFee(fees: CardFee[], sale: SaleKey): CardFee | null {
  const machineId = sale.machineId || "";
  if (machineId) {
    const own = pickCardFee(fees.filter((fee) => fee.machineId === machineId), sale);
    if (own) return own;
  }
  return pickCardFee(
    fees.filter(
      (fee) => !fee.machineId && (!fee.companyId || fee.companyId === sale.companyId),
    ),
    sale,
  );
}

function pickCardFee(fees: CardFee[], sale: SaleKey): CardFee | null {
  const brand = normalizeBrand(sale.brand);
  const candidates = fees.filter((fee) => {
    if (fee.acquirerId !== sale.acquirerId) return false;
    if (fee.modality !== sale.modality) return false;
    if (fee.modality === "credit" && Number(fee.installments || 1) !== Number(sale.installments || 1)) {
      return false;
    }
    const feeBrand = normalizeBrand(fee.brand);
    if (feeBrand && feeBrand !== brand) return false;
    if (fee.validFrom && fee.validFrom > sale.date) return false;
    if (fee.validTo && fee.validTo < sale.date) return false;
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aSpecific = normalizeBrand(a.brand) ? 1 : 0;
    const bSpecific = normalizeBrand(b.brand) ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    const aCompany = a.companyId ? 1 : 0;
    const bCompany = b.companyId ? 1 : 0;
    if (aCompany !== bCompany) return bCompany - aCompany;
    return (b.validFrom || "").localeCompare(a.validFrom || "");
  });
  return candidates[0];
}

/**
 * Custo previsto de uma venda: taxa da adquirente + (opcional) taxa de
 * antecipação, ambas em basis points sobre o valor bruto. Trunca para o
 * centavo (arredonda meio pra cima). `netCents` é o que se espera receber.
 */
export function computeSaleFinance(input: {
  grossCents: number;
  feeBps: number;
  anticipationBps?: number;
}): { expectedFeeCents: number; netCents: number } {
  const gross = Math.max(0, Math.round(input.grossCents));
  const totalBps = Math.max(0, Number(input.feeBps || 0)) + Math.max(0, Number(input.anticipationBps || 0));
  const expectedFeeCents = Math.round((gross * totalBps) / 10000);
  return { expectedFeeCents, netCents: gross - expectedFeeCents };
}

// ---------------------------------------------------------------------------
// Conciliação de vendas (itens 5 e 6) — cruzamento da taxa cadastrada com a
// taxa real cobrada pela adquirente (derivada do repasse).
// ---------------------------------------------------------------------------

export const CARD_RECON_STATUSES = ["pending", "ok", "attention", "reviewed"] as const;
export type CardReconStatus = (typeof CARD_RECON_STATUSES)[number];

export function isCardReconStatus(value: unknown): value is CardReconStatus {
  return typeof value === "string" && (CARD_RECON_STATUSES as readonly string[]).includes(value);
}

// Tolerância do cruzamento. A venda só é marcada "Em Atenção" quando a taxa
// efetiva foge da cadastrada em MAIS que os dois limites ao mesmo tempo —
// assim o arredondamento de centavos das adquirentes não gera falso alerta.
export const CARD_RECON_TOLERANCE_BPS = 15; // 0,15 ponto percentual
export const CARD_RECON_TOLERANCE_FIXED_CENTS = 50; // R$ 0,50

/**
 * Status de conciliação de uma venda de cartão:
 *  - 'reviewed'  quando já foi marcada manualmente como revisada;
 *  - 'attention' quando não há taxa cadastrada (feeMissing) OU a taxa real
 *    cobrada (bruto − recebido) diverge da prevista além da tolerância;
 *  - 'pending'   quando o repasse ainda não foi casado;
 *  - 'ok'        quando a taxa real bate com a cadastrada.
 */
export function computeCardReconStatus(input: {
  feeMissing: boolean;
  grossCents: number;
  expectedFeeCents: number;
  receivedCents: number | null | undefined;
  reviewedAt?: string;
  toleranceBps?: number;
  toleranceFixedCents?: number;
}): CardReconStatus {
  if (input.reviewedAt) return "reviewed";
  if (input.feeMissing) return "attention";
  if (input.receivedCents === null || input.receivedCents === undefined) return "pending";
  const gross = Math.round(input.grossCents);
  const actualFeeCents = gross - Math.round(input.receivedCents);
  return feeOutsideTolerance(gross, actualFeeCents - Math.round(input.expectedFeeCents), input)
    ? "attention"
    : "ok";
}

export function feeOutsideTolerance(
  grossCents: number,
  diffCents: number,
  options: { toleranceBps?: number; toleranceFixedCents?: number } = {},
): boolean {
  const diff = Math.abs(diffCents);
  const bps = options.toleranceBps ?? CARD_RECON_TOLERANCE_BPS;
  const fixed = options.toleranceFixedCents ?? CARD_RECON_TOLERANCE_FIXED_CENTS;
  return diff > fixed && diff > (Math.abs(grossCents) * bps) / 10000;
}

// ---------------------------------------------------------------------------
// Conferência na importação (Financeiro 5/9): a taxa REAL vem do próprio
// arquivo de vendas (taxa em R$, taxa em % ou bruto − líquido).
// ---------------------------------------------------------------------------

export type FeeCheck = "" | "ok" | "divergent";

/** Taxa cobrada em centavos pelo que o arquivo trouxe; null = sem taxa/líquido. */
export function resolveChargedFeeCents(input: {
  grossCents: number;
  feeCents?: number | null;
  feeBps?: number | null;
  netCents?: number | null;
}): number | null {
  const gross = Math.round(input.grossCents);
  const has = (value: number | null | undefined): value is number =>
    value !== null && value !== undefined && Number.isFinite(Number(value));
  let charged: number | null = null;
  if (has(input.feeCents)) charged = Math.round(Math.abs(input.feeCents));
  else if (has(input.feeBps)) charged = Math.round((gross * Math.abs(input.feeBps)) / 10000);
  else if (has(input.netCents) && input.netCents > 0) charged = gross - Math.round(input.netCents);
  return charged !== null && charged >= 0 && charged <= gross ? charged : null;
}

/**
 * Cobrada × cadastrada pela MESMA tolerância do repasse. '' quando o arquivo
 * não trouxe taxa ou não há taxa cadastrada (essa vai como SEM TAXA).
 */
export function computeFeeCheck(input: {
  grossCents: number;
  expectedFeeCents: number;
  chargedFeeCents: number | null | undefined;
  feeMissing: boolean;
}): FeeCheck {
  if (input.feeMissing || input.chargedFeeCents === null || input.chargedFeeCents === undefined) return "";
  return feeOutsideTolerance(input.grossCents, input.chargedFeeCents - input.expectedFeeCents)
    ? "divergent"
    : "ok";
}

/** Taxa efetiva cobrada pela adquirente (bruto − recebido) em basis points. */
export function actualFeeBps(
  grossCents: number,
  receivedCents: number | null | undefined,
): number | null {
  if (receivedCents === null || receivedCents === undefined) return null;
  const gross = Math.round(grossCents);
  if (gross <= 0) return null;
  return Math.round(((gross - Math.round(receivedCents)) / gross) * 10000);
}

/**
 * Divergência = valor recebido − líquido previsto. null enquanto o repasse
 * não chegou (receivedCents null/undefined).
 */
export function computeDivergenceCents(
  netCents: number,
  receivedCents: number | null | undefined,
): number | null {
  if (receivedCents === null || receivedCents === undefined) return null;
  return Math.round(receivedCents) - Math.round(netCents);
}

export type SaleForTotals = {
  companyId: string;
  companyName: string;
  machineId: string;
  machineLabel: string;
  acquirerName: string;
  brand: string;
  grossCents: number;
  expectedFeeCents: number;
  chargedFeeCents: number | null;
  feeMissing: boolean;
};

export type FeeTotalsRow = {
  key: string;
  label: string;
  salesCount: number;
  grossCents: number;
  /** Taxa paga: a cobrada (arquivo) quando houver, senão a cadastrada. */
  feeCents: number;
  feeBps: number;
  /** Cobrada − cadastrada, só nas vendas com as duas. */
  differenceCents: number;
};

/**
 * TOTAL DE TAXAS: cards do período + quebras LOJAS × ASSISTÊNCIA, por
 * unidade, por maquineta e por adquirente/bandeira (o antigo relatório
 * mensal). `fromFilePct` = quanto do valor de taxa veio do arquivo.
 */
export function summarizeCardFeeTotals(
  sales: SaleForTotals[],
  assistanceId: string = ASSISTANCE_COMPANY_ID,
) {
  const groups = {
    split: new Map<string, FeeTotalsRow>(),
    byCompany: new Map<string, FeeTotalsRow>(),
    byMachine: new Map<string, FeeTotalsRow>(),
    byAcquirerBrand: new Map<string, FeeTotalsRow>(),
  };
  const total = emptyTotalsRow("total", "TOTAL");
  let overchargedCents = 0;
  let fromFileFeeCents = 0;
  const add = (map: Map<string, FeeTotalsRow>, key: string, label: string, sale: SaleForTotals, fee: number, diff: number) => {
    const row = map.get(key) ?? emptyTotalsRow(key, label);
    accumulate(row, sale.grossCents, fee, diff);
    map.set(key, row);
  };
  for (const sale of sales) {
    const charged = sale.chargedFeeCents;
    const fee = charged === null || charged === undefined ? sale.expectedFeeCents : charged;
    if (charged !== null && charged !== undefined) fromFileFeeCents += charged;
    const diff = charged === null || charged === undefined || sale.feeMissing ? 0 : charged - sale.expectedFeeCents;
    if (diff > 0) overchargedCents += diff;
    accumulate(total, sale.grossCents, fee, diff);
    const isAssistance = sale.companyId === assistanceId;
    add(groups.split, isAssistance ? "assistencia" : "lojas", isAssistance ? "ASSISTÊNCIA" : "LOJAS", sale, fee, diff);
    add(groups.byCompany, sale.companyId || "-", sale.companyName || "SEM UNIDADE", sale, fee, diff);
    add(groups.byMachine, sale.machineId || "-", sale.machineLabel || "SEM MAQUINETA", sale, fee, diff);
    const brand = sale.brand || "—";
    add(groups.byAcquirerBrand, `${sale.acquirerName} ${brand}`, `${sale.acquirerName || "—"} · ${brand}`, sale, fee, diff);
  }
  const sorted = (map: Map<string, FeeTotalsRow>) =>
    [...map.values()].map(withBps).sort((a, b) => b.grossCents - a.grossCents || a.label.localeCompare(b.label));
  return {
    totals: {
      ...withBps(total),
      overchargedCents,
      fromFileFeeCents,
      fromFilePct: total.feeCents ? Math.round((fromFileFeeCents / total.feeCents) * 100) : 0,
    },
    split: ["lojas", "assistencia"].map((key) =>
      withBps(groups.split.get(key) ?? emptyTotalsRow(key, key === "lojas" ? "LOJAS" : "ASSISTÊNCIA")),
    ),
    byCompany: sorted(groups.byCompany),
    byMachine: sorted(groups.byMachine),
    byAcquirerBrand: sorted(groups.byAcquirerBrand),
  };
}

function emptyTotalsRow(key: string, label: string): FeeTotalsRow {
  return { key, label, salesCount: 0, grossCents: 0, feeCents: 0, feeBps: 0, differenceCents: 0 };
}

function accumulate(row: FeeTotalsRow, grossCents: number, feeCents: number, diffCents: number) {
  row.salesCount += 1;
  row.grossCents += grossCents;
  row.feeCents += feeCents;
  row.differenceCents += diffCents;
}

function withBps(row: FeeTotalsRow): FeeTotalsRow {
  return { ...row, feeBps: row.grossCents ? Math.round((row.feeCents / row.grossCents) * 10000) : 0 };
}
