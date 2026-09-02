import type { getD1 } from "../../../../db";

// Contribuição do RH (Folha, Benefícios, Comissões) para a DRE — item 13.
//
// O valor de cada bloco é sempre o CUSTO TOTAL (item 6/7): valores BRUTOS,
// nunca os já descontados, mais os encargos patronais no caso da folha.
// Calculado ao vivo a partir de hr_payroll_entries / hr_benefits /
// hr_commissions — nunca gravado em finance_store_entries.
//
// O mapeamento bloco → item da DRE fica em hr_dre_mapping (config global).
// Rateio/centro de custo não se aplicam: o custo é atribuído à loja do
// funcionário (company_id, denormalizado nos lançamentos de RH).

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

const EMPTY: PayrollDreContribution = { byItem: new Map(), blocks: [] };

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
  const mappingResult = await database
    .prepare("SELECT block, finance_item_id AS financeItemId FROM hr_dre_mapping WHERE finance_item_id <> ''")
    .all<{ block: string; financeItemId: string }>();
  const mapping = new Map<PayrollBlock, string>();
  for (const row of mappingResult.results ?? []) {
    if (row.block === "folha" || row.block === "beneficios" || row.block === "comissoes") {
      mapping.set(row.block, row.financeItemId);
    }
  }
  if (!mapping.size) return EMPTY;

  const isStore = scope !== "stores";
  const companyId = isStore ? scope.companyId : "";
  // "stores" = todas as lojas reais: exclui RH sem loja e o da Assistência,
  // que têm DRE própria (item 8).
  const companyCond = isStore ? "company_id = ?2" : "company_id <> '' AND company_id <> 'assistencia'";
  const bind = (extra: unknown[]) => (isStore ? [month, companyId, ...extra] : [month, ...extra]);

  const chargesRow = await database
    .prepare("SELECT employer_charges_bps AS bps FROM hr_payroll_settings WHERE company_id='' LIMIT 1")
    .first<{ bps: number }>();
  const employerChargesBps = Math.max(0, Number(chargesRow?.bps ?? 0));

  const [folhaRow, beneficiosRow, comissoesRow] = await Promise.all([
    mapping.has("folha")
      ? database
          .prepare(
            `SELECT
               COALESCE(SUM(base_salary_cents + bonus_cents + overtime_cents + additions_cents + other_cents), 0) AS salaryGross,
               COALESCE(SUM(base_salary_cents), 0) AS baseTotal
             FROM hr_payroll_entries WHERE month = ?1 AND ${companyCond}`,
          )
          .bind(...bind([]))
          .first<{ salaryGross: number; baseTotal: number }>()
      : Promise.resolve(null),
    mapping.has("beneficios")
      ? database
          .prepare(
            `SELECT COALESCE(SUM(gross_cents), 0) AS total
             FROM hr_benefits WHERE month = ?1 AND ${companyCond}`,
          )
          .bind(...bind([]))
          .first<{ total: number }>()
      : Promise.resolve(null),
    mapping.has("comissoes")
      ? database
          .prepare(
            `SELECT COALESCE(SUM(commission_cents + bonuses_cents + premiums_cents + adjustments_cents), 0) AS total
             FROM hr_commissions WHERE month = ?1 AND ${companyCond}`,
          )
          .bind(...bind([]))
          .first<{ total: number }>()
      : Promise.resolve(null),
  ]);

  const amounts: Record<PayrollBlock, number> = {
    folha: folhaRow
      ? Number(folhaRow.salaryGross || 0) +
        Math.round((Number(folhaRow.baseTotal || 0) * employerChargesBps) / 10000)
      : 0,
    beneficios: beneficiosRow ? Number(beneficiosRow.total || 0) : 0,
    comissoes: comissoesRow ? Number(comissoesRow.total || 0) : 0,
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
