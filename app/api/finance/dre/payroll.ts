import type { getD1 } from "../../../../db";
import { actingStoresForMonth } from "../../../lib/acting-store";
import { loadOvertimePayouts } from "../../hr-payroll/shared";
import { companyRole } from "../../../lib/company-role";
import { distributeAmount, weightsToBasisPoints, type RateioWeight } from "../../../lib/rateio-distribute";
import { isAutoRateioModel, type AutoRateioModel } from "../../../lib/rateio-models";
import { loadCompanyList } from "../shared";
import { loadAutoRateioWeights } from "../expenses/rateio";

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
  /** Detalhe por bloco (para o drill-down da célula); label = parte rateada do Depósito/Escritório. */
  blocks: Array<{ block: PayrollBlock; financeItemId: string; amountCents: number; label?: string }>;
};

// Custo de funcionário do DEPÓSITO e do ESCRITÓRIO (04/11/2026): rateado
// entre as lojas pelo modelo escolhido (padrão RATEIO GRUPO), calculado ao
// vivo a cada mês. Sem peso no mês (ex.: Feito ainda não lançado) o custo
// fica só na Consolidada, como antes.
export type OverheadKind = "deposito" | "escritorio";
export const OVERHEAD_LABELS: Record<OverheadKind, string> = { deposito: "DEPÓSITO", escritorio: "ESCRITÓRIO" };
export const OVERHEAD_SETTINGS_KEY = "finance_dre_overhead_rateio";
export type OverheadSettings = Record<OverheadKind, AutoRateioModel>;

export async function loadOverheadSettings(database: Database): Promise<OverheadSettings> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key=?1")
    .bind(OVERHEAD_SETTINGS_KEY)
    .first<{ value: string }>();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row?.value || "{}") || {};
  } catch {
    parsed = {};
  }
  const pick = (value: unknown): AutoRateioModel => (isAutoRateioModel(value) ? value : "faturamento");
  return { deposito: pick(parsed.deposito), escritorio: pick(parsed.escritorio) };
}

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
  return payrollDreContributionFrom(await loadPayrollDreMonth(database, month), scope);
}

export type PayrollDreMonth = Awaited<ReturnType<typeof loadPayrollDreMonth>>;

/**
 * Tudo o que a contribuição do RH precisa no mês, numa leva só de consultas
 * paralelas — carregado UMA vez e reaproveitado para cada loja do
 * comparativo (payrollDreContributionFrom é só cálculo).
 */
export async function loadPayrollDreMonth(database: Database, month: string) {
  const [actingStores, chargesRow, folhaRows, beneficiosRows, comissoesRows, overtimePayouts, companies, overheadSettings] = await Promise.all([
    actingStoresForMonth(database, month),
    database
      .prepare("SELECT employer_charges_bps AS bps FROM hr_payroll_settings WHERE company_id='' LIMIT 1")
      .first<{ bps: number }>(),
    database
      .prepare(
        `SELECT employee_id AS employeeId, company_id AS companyId,
                COALESCE(SUM(base_salary_cents + bonus_cents + overtime_cents + additions_cents + other_cents), 0) AS salaryGross,
                COALESCE(SUM(base_salary_cents), 0) AS baseTotal,
                COALESCE(SUM(overtime_cents), 0) AS overtimeTotal
         FROM hr_payroll_entries WHERE month = ?1 GROUP BY employee_id, company_id`,
      )
      .bind(month)
      .all<{ employeeId: string; companyId: string; salaryGross: number; baseTotal: number; overtimeTotal: number }>(),
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
                COALESCE(SUM(commission_cents + commercial_premium_cents + bonuses_cents + premiums_cents + adjustments_cents), 0) AS total,
                COALESCE(SUM(assist_cents), 0) AS assistTotal
         FROM hr_commissions WHERE month = ?1 GROUP BY employee_id, company_id`,
      )
      .bind(month)
      .all<{ employeeId: string; companyId: string; total: number; assistTotal: number }>(),
    // HE A PAGAR do Controle de Horas substitui a HE digitada na Folha (e conta
    // mesmo para quem ainda não tem folha lançada no mês).
    loadOvertimePayouts(database, month),
    loadCompanyList(database),
    loadOverheadSettings(database),
  ]);
  const overheadOf = new Map<string, OverheadKind>();
  // Unidade ASSISTÊNCIA: recebe a parte da comissão do operacional que é dela.
  const assistanceId = companies.find((company) => companyRole(company.name) === "assistance")?.id ?? "";
  for (const company of companies) {
    const role = companyRole(company.name);
    if (role === "depot") overheadOf.set(company.id, "deposito");
    if (role === "office") overheadOf.set(company.id, "escritorio");
  }
  const overheadWeights = new Map<OverheadKind, RateioWeight[]>();
  for (const kind of Object.keys(OVERHEAD_LABELS) as OverheadKind[]) {
    if ([...overheadOf.values()].includes(kind)) {
      overheadWeights.set(kind, await loadAutoRateioWeights(database, overheadSettings[kind], month));
    }
  }
  return {
    assistanceId,
    overheadOf,
    overheadWeights,
    actingStores,
    employerChargesBps: Math.max(0, Number(chargesRow?.bps ?? 0)),
    folhaRows,
    beneficiosRows,
    comissoesRows,
    overtimePayouts,
  };
}

export function payrollDreContributionFrom(
  data: PayrollDreMonth,
  scope: { companyId: string } | "stores",
): PayrollDreContribution {
  const { actingStores, employerChargesBps, folhaRows, beneficiosRows, comissoesRows, overtimePayouts, overheadOf, overheadWeights, assistanceId } = data;
  const mapping = new Map<PayrollBlock, string>(
    (Object.keys(PAYROLL_DRE_ITEMS) as PayrollBlock[]).map((block) => [block, PAYROLL_DRE_ITEMS[block].id]),
  );

  const isStore = scope !== "stores";
  const companyId = isStore ? scope.companyId : "";
  // Loja do custo = loja ATUANTE do funcionário no mês (RH > Funcionários),
  // com a loja gravada no lançamento como reserva. "stores" = todas as lojas
  // reais: exclui RH sem loja e o da Assistência.
  const storeOf = (row: { employeeId: string; companyId: string }) => actingStores.get(row.employeeId)?.companyId || row.companyId || "";

  /** Custo total por bloco dos funcionários cuja loja do mês passa no filtro. */
  const amountsFor = (inScope: (store: string) => boolean): Record<PayrollBlock, number> => {
    const folha = (folhaRows.results ?? []).filter((row) => inScope(storeOf(row)));
    const withFolha = new Set((folhaRows.results ?? []).map((row) => row.employeeId));
    const overtimeAdjust =
      folha.reduce((sum, row) => {
        const payout = overtimePayouts.get(row.employeeId);
        return payout === undefined ? sum : sum - Number(row.overtimeTotal || 0) + payout;
      }, 0) +
      [...overtimePayouts]
        .filter(([employeeId]) => !withFolha.has(employeeId) && inScope(storeOf({ employeeId, companyId: "" })))
        .reduce((sum, [, cents]) => sum + cents, 0);
    const sumOf = (rows: Array<{ employeeId: string; companyId: string; total: number }> | undefined) =>
      (rows ?? []).filter((row) => inScope(storeOf(row))).reduce((sum, row) => sum + Number(row.total || 0), 0);
    // Comissão do operacional (04/11/2026): a parte da assistência (feito +
    // premiação da assistência) é despesa da unidade ASSISTÊNCIA; o resto
    // (premiação pela loja) fica na loja atuante.
    const comissoes = (comissoesRows.results ?? []).reduce((sum, row) => {
      const assist = assistanceId ? Number(row.assistTotal || 0) : 0;
      return sum + (inScope(storeOf(row)) ? Number(row.total || 0) - assist : 0) + (inScope(assistanceId) ? assist : 0);
    }, 0);
    return {
      folha:
        folha.reduce((sum, row) => sum + Number(row.salaryGross || 0), 0) +
        overtimeAdjust +
        Math.round((folha.reduce((sum, row) => sum + Number(row.baseTotal || 0), 0) * employerChargesBps) / 10000),
      beneficios: sumOf(beneficiosRows.results),
      comissoes,
    };
  };

  const allocated = (kind: OverheadKind | undefined) => Boolean(kind && overheadWeights.get(kind)?.length);
  const amounts: Record<PayrollBlock, number> = isStore
    ? allocated(overheadOf.get(companyId))
      ? { folha: 0, beneficios: 0, comissoes: 0 } // custo já distribuído entre as lojas
      : amountsFor((store) => store === companyId)
    : amountsFor((store) => store !== "" && store !== "assistencia");

  // Parte desta loja no custo do Depósito/Escritório (pelo peso do mês).
  const shares: Array<{ block: PayrollBlock; amountCents: number; label: string }> = [];
  if (isStore) {
    for (const [kind, weights] of overheadWeights) {
      if (!weights.some((item) => item.companyId === companyId)) continue;
      const totals = amountsFor((store) => overheadOf.get(store) === kind);
      const basis = weightsToBasisPoints(weights);
      for (const block of Object.keys(totals) as PayrollBlock[]) {
        const amountCents = distributeAmount(totals[block], basis).find((share) => share.companyId === companyId)?.amountCents ?? 0;
        if (amountCents) shares.push({ block, amountCents, label: `${PAYROLL_BLOCK_LABELS[block]} — RATEIO ${OVERHEAD_LABELS[kind]}` });
      }
    }
  }

  const byItem = new Map<string, number>();
  const blocks: PayrollDreContribution["blocks"] = [];
  for (const [block, financeItemId] of mapping) {
    const amountCents = amounts[block];
    if (!amountCents) continue;
    byItem.set(financeItemId, (byItem.get(financeItemId) ?? 0) + amountCents);
    blocks.push({ block, financeItemId, amountCents });
  }
  for (const share of shares) {
    const financeItemId = mapping.get(share.block)!;
    byItem.set(financeItemId, (byItem.get(financeItemId) ?? 0) + share.amountCents);
    blocks.push({ block: share.block, financeItemId, amountCents: share.amountCents, label: share.label });
  }
  return { byItem, blocks };
}
