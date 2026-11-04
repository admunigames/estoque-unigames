// Modelos de rateio de despesa entre lojas (constantes puras, sem banco).
//
// - padrao / administrativo: percentuais fixos configurados manualmente.
// - faturamento*: recalculados a cada mês a partir do faturamento real da
//   competência (finance_store_revenue). "faturamento" usa o total
//   (vendas + serviços); as variantes usam só uma das bases.
// - funcionarios: proporcional ao quadro de funcionários por loja.
// - personalizado: digitado manualmente no lançamento.

export const RATEIO_MODELS = [
  "padrao",
  "administrativo",
  "faturamento",
  "faturamento_vendas",
  "faturamento_servicos",
  "funcionarios",
  "personalizado",
] as const;

export type RateioModel = (typeof RATEIO_MODELS)[number];

/** Modelos cuja base é o faturamento da competência. */
export const REVENUE_RATEIO_MODELS = [
  "faturamento",
  "faturamento_vendas",
  "faturamento_servicos",
] as const;

/**
 * Rateios AUTOMÁTICOS (04/11/2026): percentual calculado do mês, sem digitar.
 * GRUPO = vendas + serviços; ASSISTÊNCIA = só serviços; UNIGAMES = só vendas
 * (Feito do Comercial); FUNCIONÁRIOS = funcionários atuantes no mês (RH).
 */
export const AUTO_RATEIO_MODELS = ["faturamento", "faturamento_servicos", "faturamento_vendas", "funcionarios"] as const;
export type AutoRateioModel = (typeof AUTO_RATEIO_MODELS)[number];
export const AUTO_RATEIO_LABELS: Record<AutoRateioModel, string> = {
  faturamento: "RATEIO GRUPO",
  faturamento_servicos: "RATEIO ASSISTÊNCIA",
  faturamento_vendas: "RATEIO UNIGAMES",
  funcionarios: "RATEIO POR QUANTIDADE DE FUNCIONÁRIOS",
};
export function isAutoRateioModel(value: unknown): value is AutoRateioModel {
  return (AUTO_RATEIO_MODELS as readonly string[]).includes(String(value));
}
