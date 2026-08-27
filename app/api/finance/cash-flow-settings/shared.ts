import { getD1 } from "../../../../db";
import { DEFAULT_CASH_FLOW_SETTINGS, type CashFlowSettings } from "../../../lib/cash-flow";

export type Database = Awaited<ReturnType<typeof getD1>>;

export type CashFlowSettingsRow = CashFlowSettings & {
  id: string;
  companyId: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const COLUMNS = `id, company_id AS companyId,
  receivables_tolerance_bps AS receivablesToleranceBps,
  receivables_tolerance_fixed_cents AS receivablesToleranceFixedCents,
  payroll_default_payment_day AS payrollDefaultPaymentDay,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

/**
 * Configuração EFETIVA de uma loja: a linha da própria loja, senão a linha
 * global (company_id=''), senão os padrões de código. Nenhuma linha é criada
 * automaticamente — a tabela pode estar completamente vazia em produção e o
 * módulo continua funcionando com DEFAULT_CASH_FLOW_SETTINGS.
 *
 * `source` diz de onde veio ('company' | 'global' | 'default'), pra tela poder
 * mostrar que está usando um padrão herdado e não uma configuração própria.
 */
export async function loadEffectiveCashFlowSettings(
  database: Database,
  companyId: string,
): Promise<CashFlowSettings & { source: "company" | "global" | "default" }> {
  const rows = await database
    .prepare(
      `SELECT ${COLUMNS} FROM finance_cash_flow_settings WHERE company_id = ?1 OR company_id = ''`,
    )
    .bind(companyId)
    .all<CashFlowSettingsRow>();
  const results = rows.results ?? [];
  const own = companyId ? results.find((row) => row.companyId === companyId) : undefined;
  const global = results.find((row) => row.companyId === "");
  const chosen = own ?? global;
  if (!chosen) return { ...DEFAULT_CASH_FLOW_SETTINGS, source: "default" };
  return {
    receivablesToleranceBps: Number(chosen.receivablesToleranceBps ?? DEFAULT_CASH_FLOW_SETTINGS.receivablesToleranceBps),
    receivablesToleranceFixedCents: Number(
      chosen.receivablesToleranceFixedCents ?? DEFAULT_CASH_FLOW_SETTINGS.receivablesToleranceFixedCents,
    ),
    payrollDefaultPaymentDay: Number(
      chosen.payrollDefaultPaymentDay ?? DEFAULT_CASH_FLOW_SETTINGS.payrollDefaultPaymentDay,
    ),
    source: own ? "company" : "global",
  };
}

export { COLUMNS as CASH_FLOW_SETTINGS_COLUMNS };
