// Comercial — metas e comissionamento dos vendedores. Regras do documento
// "ESTRUTURA DASH COMERCIAL - CENTRAL UNIGAMES":
//
//   Faturamento  → comissão 0,4% entre 80% e 99,9% da meta; 0,6% a partir de 100%
//   Itens        → premiação R$ 500 a partir de 110%; R$ 1.500 a partir de 120%
//                  (NÃO cumulativa: 120% paga R$ 1.500, não R$ 2.000 —
//                  decisão confirmada com o usuário)
//   Garantia     → 4% fixo sobre o realizado, sem faixa de meta
//
// Tudo aqui é calculado ao vivo a partir de commercial_goals e
// commercial_entries — nada disso é persistido (mesmo padrão do
// Comissionamento do RH Financeiro).
//
// Lançamento ACUMULADO (decisão confirmada com o usuário): cada linha de
// commercial_entries informa o total acumulado do mês até a data do
// lançamento, para um vendedor/canal/tipo. O realizado é sempre o
// lançamento mais recente (maior data; empate → maior created_at), e os
// anteriores ficam como histórico. Excluir um lançamento errado faz o
// realizado voltar ao anterior.

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const COMMERCIAL_CHANNELS = ["loja", "online"] as const;
export type CommercialChannel = (typeof COMMERCIAL_CHANNELS)[number];

export const COMMERCIAL_KINDS = ["faturamento", "itens", "garantia"] as const;
export type CommercialKind = (typeof COMMERCIAL_KINDS)[number];

// Os 4 alvos do dashboard (Faturamento e Itens), em % da meta.
export const COMMERCIAL_TARGETS = [80, 100, 110, 120] as const;

export const REVENUE_RATE_LOW = 0.004; // 80% a 99,9%
export const REVENUE_RATE_HIGH = 0.006; // a partir de 100%
export const ITEMS_PREMIUM_LOW_CENTS = 50_000; // a partir de 110%
export const ITEMS_PREMIUM_HIGH_CENTS = 150_000; // a partir de 120%
export const WARRANTY_RATE = 0.04;

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * Minúsculo, sem acento e sem espaços nas pontas — base da regra "quem é
 * vendedor": CARGO (hr_employees.role_title, texto livre) contendo
 * "vendedor" bate com "Vendedor", "VENDEDOR(A)", "vendedora", "Vendedor
 * Externo" etc. Decisão confirmada: manter texto livre, sem migrar cargos.
 */
export function normalizeRoleText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function isSellerRole(roleTitle: string): boolean {
  return normalizeRoleText(roleTitle).includes("vendedor");
}

export type ChannelTotals = { loja: number; online: number; total: number };
export type RealizedTotals = Record<CommercialKind, ChannelTotals>;

export type EntryLike = {
  channel: string;
  kind: string;
  value: number;
  entryDate: string;
  createdAt: string;
};

function isNewer(candidate: EntryLike, current: EntryLike): boolean {
  if (candidate.entryDate !== current.entryDate) return candidate.entryDate > current.entryDate;
  return candidate.createdAt > current.createdAt;
}

/** Realizado do mês = lançamento acumulado mais recente de cada canal/tipo. */
export function realizedFromEntries(entries: EntryLike[]): RealizedTotals {
  const latest = new Map<string, EntryLike>();
  for (const entry of entries) {
    if (!isOneOf(COMMERCIAL_CHANNELS, entry.channel) || !isOneOf(COMMERCIAL_KINDS, entry.kind)) continue;
    const key = `${entry.kind}:${entry.channel}`;
    const current = latest.get(key);
    if (!current || isNewer(entry, current)) latest.set(key, entry);
  }
  const result = {} as RealizedTotals;
  for (const kind of COMMERCIAL_KINDS) {
    const loja = Math.max(0, Math.round(latest.get(`${kind}:loja`)?.value ?? 0));
    const online = Math.max(0, Math.round(latest.get(`${kind}:online`)?.value ?? 0));
    result[kind] = { loja, online, total: loja + online };
  }
  return result;
}

/** % da meta atingido (1 casa decimal) — null quando não há meta cadastrada. */
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
  // 1..4 para Faturamento/Itens (Alvo N); 1 para Garantia (a própria meta).
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
  targetWarrantyCents: number;
};

export type MetricBlock = {
  target: number;
  realized: ChannelTotals;
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
  items: MetricBlock;
  warranty: MetricBlock;
  commission: CommissionBreakdown;
};

function metricBlock(
  target: number,
  realized: ChannelTotals,
  thresholds: readonly number[],
  clock: MonthClock,
): MetricBlock {
  const percent = progressPercent(realized.total, target);
  const reachedTargets = target > 0
    ? thresholds.filter((threshold) => realized.total >= targetValue(target, threshold)).length
    : 0;
  return {
    target,
    realized,
    percent,
    tier: progressTier(percent),
    reachedTargets,
    next: nextTarget(realized.total, target, thresholds, clock),
  };
}

export function computeSellerMetrics(
  goal: Goal | null,
  realized: RealizedTotals,
  clock: MonthClock,
): SellerMetrics {
  const revenue = metricBlock(goal?.targetRevenueCents ?? 0, realized.faturamento, COMMERCIAL_TARGETS, clock);
  const items = metricBlock(goal?.targetItems ?? 0, realized.itens, COMMERCIAL_TARGETS, clock);
  const warranty = metricBlock(goal?.targetWarrantyCents ?? 0, realized.garantia, [100], clock);

  // Os limiares usam o valor absoluto do alvo (targetValue), não o % já
  // arredondado pra exibição — assim 79,99% nunca "vira" 80% por
  // arredondamento e destrava uma faixa que não foi batida.
  const revenueRate = revenue.target > 0
    ? (revenue.realized.total >= targetValue(revenue.target, 100)
      ? REVENUE_RATE_HIGH
      : revenue.realized.total >= targetValue(revenue.target, 80) ? REVENUE_RATE_LOW : 0)
    : 0;
  const itemsPremium = items.target > 0
    ? (items.realized.total >= targetValue(items.target, 120)
      ? ITEMS_PREMIUM_HIGH_CENTS
      : items.realized.total >= targetValue(items.target, 110) ? ITEMS_PREMIUM_LOW_CENTS : 0)
    : 0;
  const revenueCommissionCents = Math.round(revenue.realized.total * revenueRate);
  const warrantyCommissionCents = Math.round(warranty.realized.total * WARRANTY_RATE);

  return {
    revenue,
    items,
    warranty,
    commission: {
      revenueRate,
      revenueCommissionCents,
      itemsPremiumCents: itemsPremium,
      warrantyCommissionCents,
      totalCents: revenueCommissionCents + itemsPremium + warrantyCommissionCents,
    },
  };
}
