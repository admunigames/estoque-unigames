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
