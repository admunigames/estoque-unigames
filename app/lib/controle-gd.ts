// Lógica pura (sem I/O) do módulo "Comercial > Controle GD" — painel de
// saldo de "gordura de vendas" (desconto/margem usada numa venda) por loja.
//
// Fica DE PROPÓSITO sem imports de outros módulos do projeto — mesma
// escolha já feita em app/lib/supplier-invoice-status.ts, pra poder ser
// testada diretamente via `node --test` sem precisar do resolvedor de
// módulos do bundler.
//
// O saldo nunca é um número solto editado diretamente: é sempre a soma de
// um ledger de ajustes (ver commercial_gd_balance_adjustments em
// db/schema.ts) — cada edição vira um registro novo (+/-), nunca um
// UPDATE que apaga o histórico. Isso é diferente do app de referência
// (que guardava o saldo em localStorage, por loja, sem auditoria nem
// sincronização entre usuários/dispositivos).

export const ADJUSTMENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type GdAdjustment = {
  adjustmentDate: string;
  amountCents: number;
};

export type GdBalanceStatus = "critico" | "negativo" | "margem_curta" | "saudavel_queda" | "saudavel";

export const GD_BALANCE_STATUS_LABELS: Record<GdBalanceStatus, string> = {
  critico: "CRÍTICO",
  negativo: "NEGATIVO",
  margem_curta: "MARGEM CURTA",
  saudavel_queda: "SAUDÁVEL (QUEDA NO MÊS)",
  saudavel: "SAUDÁVEL",
};

// Limiares confirmados com o usuário (unificam os dois critérios
// divergentes do app de referência, que davam respostas diferentes pro
// mesmo par saldo/movimento — ver histórico da conversa de planejamento).
const CRITICAL_BALANCE_CENTS = -80000; // -R$800
const CRITICAL_MONTH_MOVEMENT_CENTS = -30000; // -R$300
const TIGHT_MARGIN_BALANCE_CENTS = 30000; // R$300

/**
 * Classifica o status de uma loja a partir do saldo acumulado e do
 * movimento (soma de ajustes) do mês corrente. Precedência, da mais forte
 * pra mais fraca:
 *   1. critico — saldo muito negativo OU o mês já consumiu muita margem
 *   2. negativo — saldo abaixo de zero (mas não crítico)
 *   3. margem_curta — saldo positivo mas baixo, uso deve ser seletivo
 *   4. saudavel_queda — saldo confortável, mas o mês está negativo (monitorar)
 *   5. saudavel — tudo bem, uso estratégico liberado
 */
export function classifyGdBalance(balanceCents: number, monthMovementCents: number): GdBalanceStatus {
  if (balanceCents <= CRITICAL_BALANCE_CENTS || monthMovementCents <= CRITICAL_MONTH_MOVEMENT_CENTS) {
    return "critico";
  }
  if (balanceCents < 0) return "negativo";
  if (balanceCents < TIGHT_MARGIN_BALANCE_CENTS) return "margem_curta";
  if (monthMovementCents < 0) return "saudavel_queda";
  return "saudavel";
}

const STATUS_RECOMMENDATION: Record<GdBalanceStatus, string> = {
  critico: "Travar gordura hoje: só liberar desconto com aprovação direta da liderança.",
  negativo: "Atenção: liberar desconto só com contrapartida clara (ex.: venda casada, ticket maior).",
  margem_curta: "Margem curta: uso seletivo, priorizar os casos de maior impacto na conversão.",
  saudavel_queda: "Saldo bom, mas o mês está em queda: monitorar o ritmo de uso nos próximos dias.",
  saudavel: "Saldo saudável: uso estratégico liberado conforme a política da loja.",
};

export type GdDailyScriptParams = {
  storeName: string;
  dateLabel: string;
  balanceCents: number;
  monthMovementCents: number;
  worstNegativeAdjustmentCents: number;
  status: GdBalanceStatus;
};

function formatCentsBRL(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const value = (Math.abs(cents) / 100).toFixed(2).replace(".", ",");
  return `${sign}R$ ${value}`;
}

/**
 * Texto formatado estilo WhatsApp (`*negrito*`) com os números do dia e a
 * recomendação de conduta pro status — pronto pra copiar
 * (`navigator.clipboard`). Adaptado de gordBuildScript do app de
 * referência: lá o "maior desconto" vinha de vendas individuais
 * cadastradas; aqui vem do pior ajuste negativo do ledger (não há cadastro
 * de venda neste módulo, só ajustes de saldo).
 */
export function buildGdDailyScript(params: GdDailyScriptParams): string {
  const { storeName, dateLabel, balanceCents, monthMovementCents, worstNegativeAdjustmentCents, status } = params;
  const lines = [
    `*CONTROLE GD · ${storeName}*`,
    `📅 ${dateLabel}`,
    "",
    `💰 Saldo atual: ${formatCentsBRL(balanceCents)}`,
    `📊 Movimento do mês: ${formatCentsBRL(monthMovementCents)}`,
  ];
  if (worstNegativeAdjustmentCents < 0) {
    lines.push(`📉 Maior ajuste negativo do mês: ${formatCentsBRL(worstNegativeAdjustmentCents)}`);
  }
  lines.push("", `*Status: ${GD_BALANCE_STATUS_LABELS[status]}*`, STATUS_RECOMMENDATION[status]);
  return lines.join("\n");
}

export type GdDailyBucket = {
  date: string;
  positiveCents: number;
  negativeCents: number;
};

/**
 * Últimas `dates.length` datas (fornecidas pelo chamador, não calculadas
 * aqui — mantém a função livre de I/O/relógio) agregadas em
 * positivo/negativo. Dias sem nenhum ajuste aparecem com 0/0 em vez de
 * sumir do array, pra o gráfico sempre ter a mesma quantidade de barras.
 */
export function aggregateLast7Days(adjustments: GdAdjustment[], dates: string[]): GdDailyBucket[] {
  const byDate = new Map<string, { positiveCents: number; negativeCents: number }>();
  for (const date of dates) {
    byDate.set(date, { positiveCents: 0, negativeCents: 0 });
  }
  for (const adjustment of adjustments) {
    const bucket = byDate.get(adjustment.adjustmentDate);
    if (!bucket) continue;
    if (adjustment.amountCents > 0) bucket.positiveCents += adjustment.amountCents;
    else bucket.negativeCents += adjustment.amountCents;
  }
  return dates.map((date) => ({ date, ...byDate.get(date)! }));
}

/** `n` datas ISO terminando (inclusive) em `todayIso`, da mais antiga pra mais nova. */
export function buildLastNDates(todayIso: string, n: number): string[] {
  const [year, month, day] = todayIso.split("-").map(Number);
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(year, month - 1, day - i));
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}
