import type { getD1 } from "../../../../db";
import { actingStoresForMonth } from "../../../lib/acting-store";

// Contribuição do RH (Folha, Benefícios, Comissões) para a DRE — item 13.
//
// O valor de cada bloco é sempre o CUSTO TOTAL (item 6/7): valores BRUTOS,
// nunca os já descontados, mais os encargos patronais no caso da folha.
// Calculado ao vivo a partir de hr_payroll_entries / hr_benefits /
// hr_commissions — nunca gravado em finance_store_entries.
//
// O RH entra AUTOMÁTICO numa categoria fixa no código (PESSOAL — RH), um item
// por bloco (ajuste do Financeiro, 22/10/2026: saiu o botão RH NA DRE). A
// tabela hr_dre_mapping fica guardada, sem uso. Rateio/centro de custo não se
// aplicam: o custo é atribuído à loja do funcionário (company_id,
// denormalizado nos lançamentos de RH).

export type PayrollBlock = "folha" | "beneficios" | "comissoes";

export const PAYROLL_BLOCK_LABELS: Record<PayrollBlock, string> = {
  folha: "Folha de Pagamento",
  beneficios: "Benefícios",
  comissoes: "Comissões",
};

type Database = Awaited<ReturnType<typeof getD1>>;

export type PayrollDreContribution = {
  /** financeItemId → total de centavos a somar naquele item da DRE. */
  byItem: Map<string, number>;
  /** Detalhe por bloco (para o drill-down da célula). */
  blocks: Array<{ block: PayrollBlock; financeItemId: string; amountCents: number }>;
};

export const PAYROLL_DRE_CATEGORY = { id: "rh-pessoal", name: "PESSOAL — RH (AUTOMÁTICO)" };
export const PAYROLL_DRE_ITEMS: Record<PayrollBlock, { id: string; name: string }> = {
  folha: { id: "rh-folha", name: "FOLHA DE PAGAMENTO (CUSTO TOTAL)" },
  beneficios: { id: "rh-beneficios", name: "BENEFÍCIOS" },
  comissoes: { id: "rh-comissoes", name: "COMISSÕES E PREMIAÇÕES" },
};

/**
 * `scope`: uma loja (companyId) para a DRE Por Loja, ou "stores" para a
 * Consolidada/Gerencial (todas as lojas reais — company_id não vazio; RH
 * sem loja, ex. Assistência, não entra na DRE das lojas).
 */
export async function loadPayrollDreContribution(
  database: Database,
  scope: { companyId: string } | "stores",
  month: string,
): Promise<PayrollDreContribution> {
  const mapping = new Map<PayrollBlock, string>(
    (Object.keys(PAYROLL_DRE_ITEMS) as PayrollBlock[]).map((block) => [block, PAYROLL_DRE_ITEMS[block].id]),
  );

  const isStore = scope !== "stores";
  const companyId = isStore ? scope.companyId : "";
  // Loja do custo = loja ATUANTE do funcionário no mês (RH > Funcionários),
  // com a loja gravada no lançamento como reserva. "stores" = todas as lojas
  // reais: exclui RH sem loja e o da Assistência.
  const actingStores = await actingStoresForMonth(database, month);
  const storeOf = (row: { employeeId: string; companyId: string }) => actingStores.get(row.employeeId)?.companyId || row.companyId || "";
  const inScope = (store: string) => (isStore ? store === companyId : store !== "" && store !== "assistencia");

  const chargesRow = await database
    .prepare("SELECT employer_charges_bps AS bps FROM hr_payroll_settings WHERE company_id='' LIMIT 1")
    .first<{ bps: number }>();
  const employerChargesBps = Math.max(0, Number(chargesRow?.bps ?? 0));

  const [folhaRows, beneficiosRows, comissoesRows] = await Promise.all([
    database
      .prepare(
        `SELECT employee_id AS employeeId, company_id AS companyId,
                COALESCE(SUM(base_salary_cents + bonus_cents + overtime_cents + additions_cents + other_cents), 0) AS salaryGross,
                COALESCE(SUM(base_salary_cents), 0) AS baseTotal
         FROM hr_payroll_entries WHERE month = ?1 GROUP BY employee_id, company_id`,
      )
      .bind(month)
      .all<{ employeeId: string; companyId: string; salaryGross: number; baseTotal: number }>(),
    database
      .prepare(
        `SELECT employee_id AS employeeId, company_id AS companyId, COALESCE(SUM(gross_cents), 0) AS total
         FROM hr_benefits WHERE month = ?1 GROUP BY employee_id, company_id`,
      )
      .bind(month)
      .all<{ employeeId: string; companyId: string; total: number }>(),
    database
      .prepare(
        `SELECT employee_id AS employeeId, company_id AS companyId,
                COALESCE(SUM(commission_cents + bonuses_cents + premiums_cents + adjustments_cents), 0) AS total
         FROM hr_commissions WHERE month = ?1 GROUP BY employee_id, company_id`,
      )
      .bind(month)
      .all<{ employeeId: string; companyId: string; total: number }>(),
  ]);
  const folha = (folhaRows.results ?? []).filter((row) => inScope(storeOf(row)));
  const sumOf = (rows: Array<{ employeeId: string; companyId: string; total: number }> | undefined) =>
    (rows ?? []).filter((row) => inScope(storeOf(row))).reduce((sum, row) => sum + Number(row.total || 0), 0);

  const amounts: Record<PayrollBlock, number> = {
    folha:
      folha.reduce((sum, row) => sum + Number(row.salaryGross || 0), 0) +
      Math.round((folha.reduce((sum, row) => sum + Number(row.baseTotal || 0), 0) * employerChargesBps) / 10000),
    beneficios: sumOf(beneficiosRows.results),
    comissoes: sumOf(comissoesRows.results),
  };

  const byItem = new Map<string, number>();
  const blocks: PayrollDreContribution["blocks"] = [];
  for (const [block, financeItemId] of mapping) {
    const amountCents = amounts[block];
    if (!amountCents) continue;
    byItem.set(financeItemId, (byItem.get(financeItemId) ?? 0) + amountCents);
    blocks.push({ block, financeItemId, amountCents });
  }
  return { byItem, blocks };
}
