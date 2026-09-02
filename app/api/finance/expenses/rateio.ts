import type { getD1 } from "../../../../db";
import { BASIS_POINTS_TOTAL, distributeAmount, type RateioShare } from "../../../lib/rateio-distribute";
import { loadCompanyList } from "../shared";
import type { RateioModel } from "./shared";

export { BASIS_POINTS_TOTAL, distributeAmount };
export type { RateioShare };

export type CustomShareInput = { companyId: string; percentBasisPoints: number };

export type RateioCalcInput = {
  model: RateioModel;
  competenceMonth: string;
  totalAmountCents: number;
  customShares?: CustomShareInput[];
};

/**
 * Calcula a divisão por loja de uma despesa rateada. Retorna a lista de
 * fatias (com nome da loja e valor em centavos já somando exatamente o
 * total) ou uma mensagem de erro (pra responder 400/409) se o modelo não
 * tiver dado suficiente pra calcular.
 */
export async function computeRateioShares(
  database: Awaited<ReturnType<typeof getD1>>,
  input: RateioCalcInput,
): Promise<{ shares: RateioShare[] } | { error: string }> {
  const { model, competenceMonth, totalAmountCents, customShares } = input;

  if (model === "personalizado") {
    if (!customShares || customShares.length < 2) {
      return { error: "INFORME AO MENOS DUAS LOJAS COM PERCENTUAL NO RATEIO PERSONALIZADO." };
    }
    if (new Set(customShares.map((share) => share.companyId)).size !== customShares.length) {
      return { error: "CADA LOJA SÓ PODE APARECER UMA VEZ NO RATEIO PERSONALIZADO." };
    }
    const totalBp = customShares.reduce((sum, share) => sum + share.percentBasisPoints, 0);
    if (totalBp !== BASIS_POINTS_TOTAL) {
      return { error: "OS PERCENTUAIS DO RATEIO PERSONALIZADO PRECISAM SOMAR EXATAMENTE 100%." };
    }
    const companies = await loadCompanyList(database);
    const unknownCompanyId = customShares.find((share) => !companies.some((c) => c.id === share.companyId));
    if (unknownCompanyId) {
      return { error: `LOJA NÃO ENCONTRADA NO RATEIO PERSONALIZADO (ID "${unknownCompanyId.companyId}").` };
    }
    const shares = customShares.map((share) => ({
      companyId: share.companyId,
      companyName: companies.find((c) => c.id === share.companyId)!.name,
      percentBasisPoints: share.percentBasisPoints,
    }));
    return { shares: distributeAmount(totalAmountCents, shares) };
  }

  if (model === "padrao" || model === "administrativo") {
    const rows = await database
      .prepare(
        "SELECT company_id AS companyId, company_name AS companyName, percent_basis_points AS percentBasisPoints FROM finance_rateio_model_shares WHERE model=?1 ORDER BY company_id",
      )
      .bind(model)
      .all<{ companyId: string; companyName: string; percentBasisPoints: number }>();
    const shares = rows.results ?? [];
    if (!shares.length) {
      return {
        error: `O MODELO DE RATEIO "${model === "padrao" ? "PADRÃO" : "ADMINISTRATIVO"}" AINDA NÃO FOI CONFIGURADO — CADASTRE OS PERCENTUAIS POR LOJA ANTES DE USÁ-LO.`,
      };
    }
    return { shares: distributeAmount(totalAmountCents, shares) };
  }

  if (model === "faturamento" || model === "faturamento_vendas" || model === "faturamento_servicos") {
    // Base do rateio: total (vendas+serviços), só vendas, ou só serviços.
    // Recalculado a cada mês a partir do faturamento real da competência.
    const column =
      model === "faturamento_vendas"
        ? "sales_amount_cents"
        : model === "faturamento_servicos"
          ? "services_amount_cents"
          : "amount_cents";
    const baseLabel =
      model === "faturamento_vendas"
        ? "FATURAMENTO DE VENDAS"
        : model === "faturamento_servicos"
          ? "FATURAMENTO DE SERVIÇOS"
          : "FATURAMENTO";
    const rows = await database
      .prepare(
        `SELECT store_id AS companyId, ${column} AS amountCents FROM finance_store_revenue
         WHERE month=?1 AND ${column} > 0 ORDER BY store_id`,
      )
      .bind(competenceMonth)
      .all<{ companyId: string; amountCents: number }>();
    const revenueRows = rows.results ?? [];
    const total = revenueRows.reduce((sum, row) => sum + row.amountCents, 0);
    if (!revenueRows.length || total <= 0) {
      return {
        error: `NÃO HÁ ${baseLabel} CADASTRADO NA DRE PARA A COMPETÊNCIA ${competenceMonth} — CADASTRE O FATURAMENTO DAS LOJAS ANTES DE USAR ESSE RATEIO NESSE MÊS.`,
      };
    }
    const companies = await loadCompanyList(database);
    const shares = revenueRows.map((row) => ({
      companyId: row.companyId,
      companyName: companies.find((c) => c.id === row.companyId)?.name || row.companyId,
      percentBasisPoints: Math.round((row.amountCents * BASIS_POINTS_TOTAL) / total),
    }));
    return { shares: distributeAmount(totalAmountCents, shares) };
  }

  if (model === "funcionarios") {
    const rows = await database
      .prepare(
        `SELECT company_id AS companyId, company_name AS companyName, employee_count AS employeeCount
         FROM finance_store_headcount WHERE employee_count > 0 ORDER BY company_id`,
      )
      .all<{ companyId: string; companyName: string; employeeCount: number }>();
    const headcountRows = rows.results ?? [];
    const total = headcountRows.reduce((sum, row) => sum + row.employeeCount, 0);
    if (!headcountRows.length || total <= 0) {
      return {
        error: "NÃO HÁ QUADRO DE FUNCIONÁRIOS CADASTRADO — CADASTRE A QUANTIDADE DE FUNCIONÁRIOS POR LOJA ANTES DE USAR O RATEIO POR FUNCIONÁRIOS.",
      };
    }
    const shares = headcountRows.map((row) => ({
      companyId: row.companyId,
      companyName: row.companyName,
      percentBasisPoints: Math.round((row.employeeCount * BASIS_POINTS_TOTAL) / total),
    }));
    return { shares: distributeAmount(totalAmountCents, shares) };
  }

  return { error: "MODELO DE RATEIO INVÁLIDO." };
}
