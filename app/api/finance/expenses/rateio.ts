import type { getD1 } from "../../../../db";
import {
  BASIS_POINTS_TOTAL,
  distributeAmount,
  restrictRateioWeights,
  weightsToBasisPoints,
  type RateioShare,
  type RateioShareInput,
  type RateioWeight,
} from "../../../lib/rateio-distribute";
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
  /** Lojas escolhidas (RATEADA ENTRE LOJAS). Vazio/ausente = todas as do modelo (comportamento anterior). */
  companyIds?: string[];
};

export type RateioCalcResult =
  | { shares: RateioShare[]; skipped: Array<{ companyId: string; companyName: string }> }
  | { error: string; status: number };

/**
 * Calcula a divisão por loja de uma despesa rateada. Retorna as fatias (com
 * nome da loja e valor em centavos somando exatamente o total) ou um erro
 * (400 = dado inválido; 409 = modelo sem dado para calcular). Com companyIds,
 * o modelo é recalculado SÓ entre as lojas escolhidas, renormalizado a 100%
 * (restrictRateioWeights); lojas sem peso no modelo ficam em `skipped`.
 */
export async function computeRateioShares(
  database: Awaited<ReturnType<typeof getD1>>,
  input: RateioCalcInput,
): Promise<RateioCalcResult> {
  const { model, competenceMonth, totalAmountCents, customShares } = input;
  const chosenIds = [...new Set((input.companyIds ?? []).filter(Boolean))];
  const companies = await loadCompanyList(database);
  const unknownChosen = chosenIds.find((id) => !companies.some((c) => c.id === id));
  if (unknownChosen) return { error: `LOJA NÃO ENCONTRADA NO RATEIO (ID "${unknownChosen}").`, status: 400 };
  const chosen = chosenIds.map((id) => ({ id, name: companies.find((c) => c.id === id)!.name }));
  const done = (shares: RateioShareInput[], skipped: Array<{ companyId: string; companyName: string }> = []): RateioCalcResult => ({
    shares: distributeAmount(totalAmountCents, shares),
    skipped,
  });
  // Pesos do modelo → fatias (todas as lojas do modelo, ou só as escolhidas).
  const fromWeights = (weights: RateioWeight[], legacy: () => RateioShareInput[]): RateioCalcResult => {
    if (!chosen.length) return done(legacy());
    const restricted = restrictRateioWeights(weights, chosen);
    if ("error" in restricted) return { error: restricted.error, status: 409 };
    return done(weightsToBasisPoints(restricted.weights), restricted.skipped);
  };

  if (model === "personalizado") {
    if (!customShares || customShares.length < 1) {
      return { error: "INFORME AO MENOS UMA LOJA COM PERCENTUAL NO RATEIO PERSONALIZADO.", status: 400 };
    }
    if (new Set(customShares.map((share) => share.companyId)).size !== customShares.length) {
      return { error: "CADA LOJA SÓ PODE APARECER UMA VEZ NO RATEIO PERSONALIZADO.", status: 400 };
    }
    const totalBp = customShares.reduce((sum, share) => sum + share.percentBasisPoints, 0);
    if (totalBp !== BASIS_POINTS_TOTAL) {
      return { error: "OS PERCENTUAIS DO RATEIO PERSONALIZADO PRECISAM SOMAR EXATAMENTE 100%.", status: 400 };
    }
    const unknownCompanyId = customShares.find((share) => !companies.some((c) => c.id === share.companyId));
    if (unknownCompanyId) {
      return { error: `LOJA NÃO ENCONTRADA NO RATEIO PERSONALIZADO (ID "${unknownCompanyId.companyId}").`, status: 400 };
    }
    if (chosen.length && customShares.some((share) => !chosenIds.includes(share.companyId))) {
      return { error: "O RATEIO PERSONALIZADO SÓ PODE USAR AS LOJAS MARCADAS.", status: 400 };
    }
    return done(
      customShares.map((share) => ({
        companyId: share.companyId,
        companyName: companies.find((c) => c.id === share.companyId)!.name,
        percentBasisPoints: share.percentBasisPoints,
      })),
    );
  }

  if (model === "padrao" || model === "administrativo") {
    const rows = await database
      .prepare(
        "SELECT company_id AS companyId, company_name AS companyName, percent_basis_points AS percentBasisPoints FROM finance_rateio_model_shares WHERE model=?1 ORDER BY company_id",
      )
      .bind(model)
      .all<{ companyId: string; companyName: string; percentBasisPoints: number }>();
    const shares = (rows.results ?? []).map((row) => ({ ...row, percentBasisPoints: Number(row.percentBasisPoints) }));
    if (!shares.length) {
      return {
        error: `O MODELO DE RATEIO "${model === "padrao" ? "PADRÃO" : "ADMINISTRATIVO"}" AINDA NÃO FOI CONFIGURADO — CADASTRE OS PERCENTUAIS POR LOJA ANTES DE USÁ-LO.`,
        status: 409,
      };
    }
    return fromWeights(
      shares.map((share) => ({ companyId: share.companyId, companyName: share.companyName, weight: share.percentBasisPoints })),
      () => shares,
    );
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
    const revenueRows = (rows.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
    const total = revenueRows.reduce((sum, row) => sum + row.amountCents, 0);
    if (!revenueRows.length || total <= 0) {
      if (chosen.length === 1) return done([{ companyId: chosen[0].id, companyName: chosen[0].name, percentBasisPoints: BASIS_POINTS_TOTAL }]);
      return {
        error: `NÃO HÁ ${baseLabel} CADASTRADO NA DRE PARA A COMPETÊNCIA ${competenceMonth} — CADASTRE O FATURAMENTO DAS LOJAS ANTES DE USAR ESSE RATEIO NESSE MÊS.`,
        status: 409,
      };
    }
    const nameOf = (id: string) => companies.find((c) => c.id === id)?.name || id;
    return fromWeights(
      revenueRows.map((row) => ({ companyId: row.companyId, companyName: nameOf(row.companyId), weight: row.amountCents })),
      () =>
        revenueRows.map((row) => ({
          companyId: row.companyId,
          companyName: nameOf(row.companyId),
          percentBasisPoints: Math.round((row.amountCents * BASIS_POINTS_TOTAL) / total),
        })),
    );
  }

  if (model === "funcionarios") {
    const rows = await database
      .prepare(
        `SELECT company_id AS companyId, company_name AS companyName, employee_count AS employeeCount
         FROM finance_store_headcount WHERE employee_count > 0 ORDER BY company_id`,
      )
      .all<{ companyId: string; companyName: string; employeeCount: number }>();
    const headcountRows = (rows.results ?? []).map((row) => ({ ...row, employeeCount: Number(row.employeeCount) }));
    const total = headcountRows.reduce((sum, row) => sum + row.employeeCount, 0);
    if (!headcountRows.length || total <= 0) {
      if (chosen.length === 1) return done([{ companyId: chosen[0].id, companyName: chosen[0].name, percentBasisPoints: BASIS_POINTS_TOTAL }]);
      return {
        error: "NÃO HÁ QUADRO DE FUNCIONÁRIOS CADASTRADO — CADASTRE A QUANTIDADE DE FUNCIONÁRIOS POR LOJA ANTES DE USAR O RATEIO POR FUNCIONÁRIOS.",
        status: 409,
      };
    }
    return fromWeights(
      headcountRows.map((row) => ({ companyId: row.companyId, companyName: row.companyName, weight: row.employeeCount })),
      () =>
        headcountRows.map((row) => ({
          companyId: row.companyId,
          companyName: row.companyName,
          percentBasisPoints: Math.round((row.employeeCount * BASIS_POINTS_TOTAL) / total),
        })),
    );
  }

  return { error: "MODELO DE RATEIO INVÁLIDO.", status: 400 };
}
