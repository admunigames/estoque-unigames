// Comercial — metas e comissionamento dos vendedores. Regras do documento
// "ESTRUTURA DASH COMERCIAL - CENTRAL UNIGAMES":
//
//   Faturamento  → comissão 0,4% entre 80% e 99,9% da meta; 0,6% a partir de 100%
//   Itens        → premiação R$ 500 a partir de 110%; R$ 1.500 a partir de 120%
//                  (NÃO cumulativa: 120% paga R$ 1.500, não R$ 2.000 —
//                  decisão confirmada com o usuário). SUPER ITENS da planilha
//                  é só marco de referência, não muda a premiação.
//   Garantia     → 4% fixo sobre o realizado, sem faixa de meta
//   Realmes      → só acompanhamento (meta × feito), sem comissão
//
// A ÚNICA fonte dos números é a planilha "ACOMPANHAMENTO LOJAS_VENDEDORES",
// aba "VENDEDORES <MÊS>" (decisão confirmada: sem digitação manual). Cada
// importação grava um retrato do mês por vendedor em commercial_monthly;
// percentual, faixa de comissão e ranking são SEMPRE calculados ao vivo
// a partir desse retrato (nada disso é persistido).

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// Os 4 alvos do dashboard (Faturamento e Itens), em % da meta.
export const COMMERCIAL_TARGETS = [80, 100, 110, 120] as const;

export const REVENUE_RATE_LOW = 0.004; // 80% a 99,9%
export const REVENUE_RATE_HIGH = 0.006; // a partir de 100%
export const ITEMS_PREMIUM_LOW_CENTS = 50_000; // a partir de 110%
export const ITEMS_PREMIUM_HIGH_CENTS = 150_000; // a partir de 120%
export const WARRANTY_RATE = 0.04;

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
};

export type CommissionBreakdown = {
  revenueRate: number;
  revenueCommissionCents: number;
  itemsPremiumCents: number;
  warrantyCommissionCents: number;
  totalCents: number;
};

export type SellerMetrics = {
  revenue: MetricBlock;
  items: MetricBlock & { superTarget: number; superReached: boolean };
  warranty: MetricBlock;
  realme: MetricBlock;
  // QT G.A.R ÷ NOTEBOOK/PC (1 casa decimal) — null sem notebook/PC vendido.
  attachPercent: number | null;
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
  };
}

export function computeSellerMetrics(goal: Goal, realized: Realized, clock: MonthClock): SellerMetrics {
  const revenue = metricBlock(goal.targetRevenueCents, realized.revenueCents, COMMERCIAL_TARGETS, clock);
  const itemsBase = metricBlock(goal.targetItems, realized.items, COMMERCIAL_TARGETS, clock);
  const warranty = metricBlock(goal.targetWarrantyCents, realized.warrantyCents, [100], clock);
  const realme = metricBlock(goal.targetRealme, realized.realme, [100], clock);

  // Os limiares usam o valor absoluto do alvo (targetValue), não o % já
  // arredondado pra exibição — 79,99% nunca "vira" 80% por arredondamento.
  const revenueRate = revenue.target > 0
    ? (revenue.realized >= targetValue(revenue.target, 100)
      ? REVENUE_RATE_HIGH
      : revenue.realized >= targetValue(revenue.target, 80) ? REVENUE_RATE_LOW : 0)
    : 0;
  const itemsPremium = itemsBase.target > 0
    ? (itemsBase.realized >= targetValue(itemsBase.target, 120)
      ? ITEMS_PREMIUM_HIGH_CENTS
      : itemsBase.realized >= targetValue(itemsBase.target, 110) ? ITEMS_PREMIUM_LOW_CENTS : 0)
    : 0;
  const revenueCommissionCents = Math.round(revenue.realized * revenueRate);
  const warrantyCommissionCents = Math.round(warranty.realized * WARRANTY_RATE);

  return {
    revenue,
    items: {
      ...itemsBase,
      superTarget: goal.targetSuperItems,
      superReached: goal.targetSuperItems > 0 && realized.items >= goal.targetSuperItems,
    },
    warranty,
    realme,
    attachPercent: realized.notebookQty > 0
      ? Math.floor((realized.warrantyQty / realized.notebookQty) * 1000) / 10
      : null,
    commission: {
      revenueRate,
      revenueCommissionCents,
      itemsPremiumCents: itemsPremium,
      warrantyCommissionCents,
      totalCents: revenueCommissionCents + itemsPremium + warrantyCommissionCents,
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
