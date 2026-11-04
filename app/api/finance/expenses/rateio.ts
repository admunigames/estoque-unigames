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
import { loadCommercialRevenueByStore } from "../revenue/commercial";
import { actingHeadcountForMonth } from "../../../lib/acting-store";
import { companyRole } from "../../../lib/company-role";
import { isAutoRateioModel, type AutoRateioModel } from "../../../lib/rateio-models";
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

  if (isAutoRateioModel(model)) {
    // Percentual automático do mês: o peso de cada loja ÷ o total das lojas.
    const weights = await loadAutoRateioWeights(database, model, competenceMonth);
    if (!weights.length) {
      if (chosen.length === 1) return done([{ companyId: chosen[0].id, companyName: chosen[0].name, percentBasisPoints: BASIS_POINTS_TOTAL }]);
      return {
        error:
          model === "funcionarios"
            ? `NÃO HÁ FUNCIONÁRIOS ATUANTES NAS LOJAS EM ${competenceMonth} (RH > FUNCIONÁRIOS).`
            : `NÃO HÁ ${AUTO_RATEIO_BASE[model]} LANÇADO NO COMERCIAL PARA A COMPETÊNCIA ${competenceMonth}.`,
        status: 409,
      };
    }
    return fromWeights(weights, () => weightsToBasisPoints(weights));
  }

  return { error: "MODELO DE RATEIO INVÁLIDO.", status: 400 };
}

const AUTO_RATEIO_BASE: Record<Exclude<AutoRateioModel, "funcionarios">, string> = {
  faturamento: "FATURAMENTO",
  faturamento_vendas: "FATURAMENTO DE VENDAS",
  faturamento_servicos: "FATURAMENTO DE SERVIÇOS",
};

/**
 * Peso de cada LOJA (sem Depósito/Assistência/Escritório) num rateio
 * automático do mês: Feito do Comercial (total, vendas ou serviços) ou
 * funcionários atuantes. Só lojas com peso > 0, em ordem de id.
 */
export async function loadAutoRateioWeights(
  database: Awaited<ReturnType<typeof getD1>>,
  model: AutoRateioModel,
  month: string,
): Promise<RateioWeight[]> {
  const stores = (await loadCompanyList(database)).filter((company) => companyRole(company.name) === "store");
  let valueOf: (companyId: string) => number;
  if (model === "funcionarios") {
    const headcount = await actingHeadcountForMonth(database, month);
    valueOf = (companyId) => headcount.get(companyId) ?? 0;
  } else {
    const revenue = await loadCommercialRevenueByStore(database, month);
    valueOf = (companyId) => {
      const row = revenue.get(companyId);
      if (!row) return 0;
      return model === "faturamento_vendas" ? row.salesCents : model === "faturamento_servicos" ? row.servicesCents : row.amountCents;
    };
  }
  return stores
    .map((company) => ({ companyId: company.id, companyName: company.name, weight: Math.max(0, Number(valueOf(company.id)) || 0) }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => a.companyId.localeCompare(b.companyId));
}
