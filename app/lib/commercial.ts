// Comercial — metas e comissionamento dos vendedores. Regra de comissão
// (definida pelo usuário em 2026-09-30):
//
//   CRITÉRIOS: Itens ≥ 100% da META ITENS, Realme ≥ 100% da META REALMES e
//   anexo de garantia ≥ 30% (QT G.A.R ÷ NOTEBOOK/PC — não existe meta de
//   G.A.R em valor).
//
//   Bateu os 3 critérios → 0,6% do faturamento + premiação sobre a META DE
//                          FATURAMENTO: R$ 500 a partir de 110%, R$ 1.500 a
//                          partir de 120% (não cumulativa).
//   Não bateu algum      → 0,4% do faturamento (sempre, sem mínimo) e sem
//                          premiação.
//   Garantia estendida   → 4% sobre o valor vendido em garantia, sempre.
//
//   Meta de Itens/Realme zerada conta como batida (não havia o que cumprir).
//   Sem notebook/PC vendido no mês o anexo não tem base → critério de 30%
//   NÃO batido.
//
// A ÚNICA fonte dos números é a planilha "ACOMPANHAMENTO LOJAS_VENDEDORES",
// aba "VENDEDORES <MÊS>" (sem digitação manual). Cada importação grava um
// retrato do mês por vendedor em commercial_monthly; percentuais, critérios
// e comissão são SEMPRE calculados ao vivo (nada disso é persistido).

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// Marcos da barra de Faturamento, em % da meta: a meta e as duas faixas de
// premiação.
export const REVENUE_TARGETS = [100, 110, 120] as const;

export const REVENUE_RATE_LOW = 0.004; // não bateu todos os critérios
export const REVENUE_RATE_HIGH = 0.006; // bateu Itens, Realme e anexo de garantia
export const REVENUE_PREMIUM_LOW_CENTS = 50_000; // faturamento ≥ 110% da meta
export const REVENUE_PREMIUM_HIGH_CENTS = 150_000; // faturamento ≥ 120% da meta
export const WARRANTY_RATE = 0.04;
export const WARRANTY_ATTACH_TARGET = 30; // % de notebooks/PC vendidos com garantia

/** Maiúsculo, sem acento, sem pontuação e com espaços simples. */
export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Regra "quem é vendedor": CARGO (hr_employees.role_title, texto livre)
 * contendo "vendedor" — bate com "Vendedor", "VENDEDOR(A)", "vendedora".
 */
export function isSellerRole(roleTitle: string): boolean {
  return normalizeText(roleTitle).includes("VENDEDOR");
}

// ---------------------------------------------------------------------------
// Cálculos
// ---------------------------------------------------------------------------

/** % da meta atingido (1 casa decimal) — null quando não há meta. */
export function progressPercent(realized: number, target: number): number | null {
  if (!(target > 0)) return null;
  return Math.floor((realized / target) * 1000) / 10;
}

/** Valor absoluto (centavos ou itens) correspondente a um alvo em %. */
export function targetValue(target: number, percent: number): number {
  return Math.ceil((target * percent) / 100);
}

export type Tier = "none" | "red" | "yellow" | "green";

/** Vermelho abaixo de 80%, amarelo de 80% a 99,9%, verde a partir de 100%. */
export function progressTier(percent: number | null): Tier {
  if (percent === null) return "none";
  if (percent >= 100) return "green";
  if (percent >= 80) return "yellow";
  return "red";
}

export type MonthClock = {
  month: string;
  today: string;
  daysInMonth: number;
  // Dias restantes CONTANDO hoje (mês corrente), o mês inteiro (mês
  // futuro) ou 0 (mês encerrado).
  daysRemaining: number;
  status: "past" | "current" | "future";
};

// `today` = YYYY-MM-DD no fuso do projeto (todayInTimezone() em
// app/lib/finance-status.ts) — recebido por parâmetro pra manter este
// arquivo sem dependências (testável direto com node --test).
export function monthClock(month: string, today: string): MonthClock {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const currentMonth = today.slice(0, 7);
  if (month < currentMonth) return { month, today, daysInMonth, daysRemaining: 0, status: "past" };
  if (month > currentMonth) return { month, today, daysInMonth, daysRemaining: daysInMonth, status: "future" };
  const day = Number(today.slice(8, 10));
  return { month, today, daysInMonth, daysRemaining: daysInMonth - day + 1, status: "current" };
}

export type NextTarget = {
  // 1..4 para Faturamento/Itens (Alvo N); 1 para Garantia/Realmes (a própria meta).
  index: number;
  percent: number;
  value: number;
  missing: number;
  // Quanto vender por dia (média) até o fim do mês — null em mês encerrado.
  perDay: number | null;
};

export function nextTarget(
  realized: number,
  target: number,
  thresholds: readonly number[],
  clock: MonthClock,
): NextTarget | null {
  if (!(target > 0)) return null;
  for (let i = 0; i < thresholds.length; i++) {
    const value = targetValue(target, thresholds[i]);
    if (realized < value) {
      const missing = value - realized;
      return {
        index: i + 1,
        percent: thresholds[i],
        value,
        missing,
        perDay: clock.daysRemaining > 0 ? Math.ceil(missing / clock.daysRemaining) : null,
      };
    }
  }
  return null;
}

export type Goal = {
  targetRevenueCents: number;
  targetItems: number;
  targetSuperItems: number;
  targetWarrantyCents: number;
  targetRealme: number;
};

export type Realized = {
  revenueCents: number;
  items: number;
  warrantyCents: number;
  realme: number;
  warrantyQty: number;
  notebookQty: number;
};

export type MetricBlock = {
  target: number;
  realized: number;
  percent: number | null;
  tier: Tier;
  reachedTargets: number;
  next: NextTarget | null;
  // Critério de comissão: realizado ≥ meta (meta zerada conta como batida).
  met: boolean;
};

export type WarrantyBlock = {
  realizedCents: number;
  warrantyQty: number;
  notebookQty: number;
  // QT G.A.R ÷ NOTEBOOK/PC (1 casa decimal) — null sem notebook/PC vendido.
  attachPercent: number | null;
  tier: Tier;
  met: boolean;
  // Quantas garantias faltam para chegar a 30% (0 quando já chegou).
  missingQty: number | null;
};

export type CommissionBreakdown = {
  allCriteriaMet: boolean;
  revenueRate: number;
  revenueCommissionCents: number;
  revenuePremiumCents: number;
  warrantyCommissionCents: number;
  totalCents: number;
};

export type SellerMetrics = {
  revenue: MetricBlock;
  items: MetricBlock & { superTarget: number; superReached: boolean };
  realme: MetricBlock;
  warranty: WarrantyBlock;
  commission: CommissionBreakdown;
};

function metricBlock(
  target: number,
  realized: number,
  thresholds: readonly number[],
  clock: MonthClock,
): MetricBlock {
  const percent = progressPercent(realized, target);
  const reachedTargets = target > 0
    ? thresholds.filter((threshold) => realized >= targetValue(target, threshold)).length
    : 0;
  return {
    target,
    realized,
    percent,
    tier: progressTier(percent),
    reachedTargets,
    next: nextTarget(realized, target, thresholds, clock),
    met: !(target > 0) || realized >= target,
  };
}

export function warrantyBlock(realized: Realized): WarrantyBlock {
  const { warrantyQty, notebookQty } = realized;
  const attachPercent = notebookQty > 0 ? Math.floor((warrantyQty / notebookQty) * 1000) / 10 : null;
  // Compara em quantidade (sem arredondar o %): 3 de 10 = exatamente 30%.
  const met = notebookQty > 0 && warrantyQty * 100 >= WARRANTY_ATTACH_TARGET * notebookQty;
  const needed = notebookQty > 0 ? Math.ceil((WARRANTY_ATTACH_TARGET * notebookQty) / 100) : null;
  let tier: Tier = "none";
  if (attachPercent !== null) {
    tier = met ? "green" : attachPercent >= WARRANTY_ATTACH_TARGET * 0.8 ? "yellow" : "red";
  }
  return {
    realizedCents: realized.warrantyCents,
    warrantyQty,
    notebookQty,
    attachPercent,
    tier,
    met,
    missingQty: needed === null ? null : Math.max(0, needed - warrantyQty),
  };
}

export function computeSellerMetrics(goal: Goal, realized: Realized, clock: MonthClock): SellerMetrics {
  const revenue = metricBlock(goal.targetRevenueCents, realized.revenueCents, REVENUE_TARGETS, clock);
  const itemsBase = metricBlock(goal.targetItems, realized.items, [100], clock);
  const realme = metricBlock(goal.targetRealme, realized.realme, [100], clock);
  const warranty = warrantyBlock(realized);

  const allCriteriaMet = itemsBase.met && realme.met && warranty.met;
  const revenueRate = allCriteriaMet ? REVENUE_RATE_HIGH : REVENUE_RATE_LOW;
  // Premiação só com todos os critérios batidos; limiares pelo valor absoluto
  // da meta (targetValue), nunca pelo % arredondado de exibição.
  const revenuePremiumCents = allCriteriaMet && revenue.target > 0
    ? (revenue.realized >= targetValue(revenue.target, 120)
      ? REVENUE_PREMIUM_HIGH_CENTS
      : revenue.realized >= targetValue(revenue.target, 110) ? REVENUE_PREMIUM_LOW_CENTS : 0)
    : 0;
  const revenueCommissionCents = Math.round(revenue.realized * revenueRate);
  const warrantyCommissionCents = Math.round(realized.warrantyCents * WARRANTY_RATE);

  return {
    revenue,
    items: {
      ...itemsBase,
      superTarget: goal.targetSuperItems,
      superReached: goal.targetSuperItems > 0 && realized.items >= goal.targetSuperItems,
    },
    realme,
    warranty,
    commission: {
      allCriteriaMet,
      revenueRate,
      revenueCommissionCents,
      revenuePremiumCents,
      warrantyCommissionCents,
      totalCents: revenueCommissionCents + revenuePremiumCents + warrantyCommissionCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Leitura da aba "VENDEDORES <MÊS>"
// ---------------------------------------------------------------------------

export type SheetRow = Goal & Realized & {
  rowNumber: number; // linha na planilha (1 = primeira)
  storeLabel: string;
  sellerLabel: string;
  zone: string;
};

export type ParsedSheet = { rows: SheetRow[]; errors: string[] };

type Field =
  | "store" | "seller" | "zone"
  | "targetRealme" | "realme"
  | "targetItems" | "targetSuperItems" | "items"
  | "targetWarranty" | "warranty" | "warrantyQty" | "notebookQty"
  | "revenue" | "targetRevenue";

// Rótulos do cabeçalho (normalizados por normalizeText) → campo. "META"
// sozinho é a meta de faturamento (coluna ao lado de FATURADO).
const HEADER_FIELDS: Record<string, Field> = {
  "LOJAS": "store",
  "LOJA": "store",
  "VENDEDOR": "seller",
  "VENDEDORES": "seller",
  "ZONA": "zone",
  "META REALMES": "targetRealme",
  "REALMES FEITO": "realme",
  "META ITENS": "targetItems",
  "SUPER ITENS": "targetSuperItems",
  "ITENS FEITO": "items",
  "META G A R": "targetWarranty",
  "META GAR": "targetWarranty",
  "GAR FEITO": "warranty",
  "QT G A R": "warrantyQty",
  "QT GAR": "warrantyQty",
  "NOTEBOOK PC": "notebookQty",
  "FATURADO": "revenue",
  "META": "targetRevenue",
};

const REQUIRED_FIELDS: Field[] = ["seller", "revenue", "targetRevenue"];
const FIELD_LABELS: Partial<Record<Field, string>> = {
  seller: "VENDEDOR",
  revenue: "FATURADO",
  targetRevenue: "META",
};

/**
 * Número de uma célula: aceita número puro (Excel) ou texto no formato
 * brasileiro ("R$ 1.234,56", "12,5"). Vazio = 0. null = inválido.
 */
export function parseSheetNumber(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value).trim();
  if (!text || text === "-") return 0;
  text = text.replace(/R\$|\s/g, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text) || /^-?\d+,\d+$/.test(text)) {
    text = text.replace(/\./g, "").replace(",", ".");
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** Nome da aba sugerida para o mês ("VENDEDORES SETEMBRO", "VENDEDORES SETEMBRO 2025"...). */
const MONTH_NAMES = [
  "JANEIRO", "FEVEREIRO", "MARCO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];

export function suggestSheetName(sheetNames: string[], month: string): string {
  const [year, monthNumber] = month.split("-");
  const monthName = MONTH_NAMES[Number(monthNumber) - 1];
  // "VENDEDORS AGOSTO." (erro de digitação na planilha real) também conta.
  const sellerSheets = sheetNames.filter((name) => /^VENDEDO/.test(normalizeText(name)));
  const ofMonth = sellerSheets.filter((name) => normalizeText(name).split(" ").includes(monthName));
  return (
    ofMonth.find((name) => normalizeText(name).includes(year)) ||
    ofMonth.find((name) => !/\b20\d\d\b/.test(normalizeText(name))) ||
    ofMonth[0] ||
    ""
  );
}

export function parseSellerSheet(cells: unknown[][]): ParsedSheet {
  const errors: string[] = [];
  let headerIndex = -1;
  const columns = new Map<Field, number>();
  for (let r = 0; r < Math.min(cells.length, 30) && headerIndex < 0; r++) {
    const labels = (cells[r] || []).map(normalizeText);
    if (labels.includes("VENDEDOR") && labels.includes("FATURADO")) {
      headerIndex = r;
      labels.forEach((label, c) => {
        const field = HEADER_FIELDS[label];
        if (field && !columns.has(field)) columns.set(field, c);
      });
    }
  }
  if (headerIndex < 0) {
    return { rows: [], errors: ["NÃO ENCONTREI O CABEÇALHO (colunas VENDEDOR e FATURADO) NAS PRIMEIRAS 30 LINHAS DA ABA."] };
  }
  const missing = REQUIRED_FIELDS.filter((field) => !columns.has(field));
  if (missing.length) {
    return { rows: [], errors: [`FALTAM AS COLUNAS: ${missing.map((field) => FIELD_LABELS[field]).join(", ")}.`] };
  }

  const cell = (row: unknown[], field: Field) => {
    const index = columns.get(field);
    return index === undefined ? undefined : row[index];
  };
  const rows: SheetRow[] = [];
  let currentStore = "";
  for (let r = headerIndex + 1; r < cells.length; r++) {
    const row = cells[r] || [];
    const storeRaw = String(cell(row, "store") ?? "").trim();
    // LOJAS vem mesclada (só a 1ª linha do grupo tem valor) — herda pra baixo.
    if (storeRaw) currentStore = storeRaw;
    const seller = String(cell(row, "seller") ?? "").trim();
    if (!seller) continue;
    if (/^(TOTAL|SUBTOTAL)\b/.test(normalizeText(seller))) continue;

    const numbers: Partial<Record<Field, number>> = {};
    let invalid = "";
    for (const field of [
      "targetRealme", "realme", "targetItems", "targetSuperItems", "items",
      "targetWarranty", "warranty", "warrantyQty", "notebookQty", "revenue", "targetRevenue",
    ] as Field[]) {
      const value = parseSheetNumber(cell(row, field));
      if (value === null || value < 0) {
        invalid = `LINHA ${r + 1} (${seller}): VALOR INVÁLIDO NA COLUNA ${field}.`;
        break;
      }
      numbers[field] = value;
    }
    if (invalid) {
      errors.push(invalid);
      continue;
    }
    const n = (field: Field) => numbers[field] ?? 0;
    rows.push({
      rowNumber: r + 1,
      storeLabel: currentStore,
      sellerLabel: seller,
      zone: normalizeText(cell(row, "zone")),
      targetRevenueCents: Math.round(n("targetRevenue") * 100),
      targetItems: Math.round(n("targetItems")),
      targetSuperItems: Math.round(n("targetSuperItems")),
      targetWarrantyCents: Math.round(n("targetWarranty") * 100),
      targetRealme: Math.round(n("targetRealme")),
      revenueCents: Math.round(n("revenue") * 100),
      items: Math.round(n("items")),
      warrantyCents: Math.round(n("warranty") * 100),
      realme: Math.round(n("realme")),
      warrantyQty: Math.round(n("warrantyQty")),
      notebookQty: Math.round(n("notebookQty")),
    });
  }
  if (!rows.length && !errors.length) errors.push("NENHUM VENDEDOR ENCONTRADO ABAIXO DO CABEÇALHO.");
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Reconhecimento do vendedor da planilha no cadastro do RH
// ---------------------------------------------------------------------------

export type EmployeeCandidate = {
  id: string;
  fullName: string;
  companyName: string;
  isSeller: boolean;
};

/** Chave do vínculo apelido → funcionário (loja + nome, normalizados). */
export function aliasKey(storeLabel: string, sellerLabel: string): string {
  return `${normalizeText(storeLabel)}|${normalizeText(sellerLabel)}`;
}

/** "RIO MAR" x "RIOMAR", "GUARARAPES" x "GUARA", "QUIOSQUE" x "P.A QUIOSQUE". */
export function storeMatches(storeLabel: string, companyName: string): boolean {
  const a = normalizeText(storeLabel).replace(/ /g, "");
  const b = normalizeText(companyName).replace(/ /g, "");
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * "OTAVIO" → "Otávio Souza"; "VITOR V." → "Vitor Vasconcelos"; "TATIANY
 * LUIZA" → "Tatiany Luiza Lima". O 1º nome precisa ser igual e cada parte
 * seguinte do apelido precisa ser início de algum sobrenome, na ordem.
 */
export function nameMatches(sellerLabel: string, fullName: string): boolean {
  const alias = normalizeText(sellerLabel).split(" ").filter(Boolean);
  const name = normalizeText(fullName).split(" ").filter(Boolean);
  if (!alias.length || !name.length || alias[0] !== name[0]) return false;
  let position = 1;
  for (const part of alias.slice(1)) {
    while (position < name.length && !name[position].startsWith(part)) position++;
    if (position >= name.length) return false;
    position++;
  }
  return true;
}

/**
 * Funcionário único que corresponde à linha, ou null (nenhum ou ambíguo).
 * Critérios em ordem: vínculo salvo → nome + loja + cargo vendedor → nome +
 * loja → nome + cargo vendedor → só nome. Em cada nível, precisa haver
 * exatamente um candidato.
 */
export function matchEmployee(
  row: Pick<SheetRow, "storeLabel" | "sellerLabel">,
  employees: EmployeeCandidate[],
  aliases: Map<string, string>,
): { employeeId: string; by: "alias" | "name" } | null {
  const saved = aliases.get(aliasKey(row.storeLabel, row.sellerLabel));
  if (saved && employees.some((employee) => employee.id === saved)) return { employeeId: saved, by: "alias" };
  const byName = employees.filter((employee) => nameMatches(row.sellerLabel, employee.fullName));
  const byStore = byName.filter((employee) => storeMatches(row.storeLabel, employee.companyName));
  for (const list of [
    byStore.filter((employee) => employee.isSeller),
    byStore,
    byName.filter((employee) => employee.isSeller),
    byName,
  ]) {
    if (list.length === 1) return { employeeId: list[0].id, by: "name" };
    if (list.length > 1) return null;
  }
  return null;
}
