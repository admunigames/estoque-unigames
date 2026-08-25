import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, type JsonMap } from "../../shared";
import { MONTH_PATTERN, RATEIO_MODELS, type RateioModel } from "../shared";
import { computeRateioShares, type CustomShareInput } from "../rateio";

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const model = safeText(body.rateioModel, 20) as RateioModel;
    if (!RATEIO_MODELS.includes(model)) return jsonResponse({ error: "MODELO DE RATEIO INVÁLIDO." }, 400);
    const competenceMonth = safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) return jsonResponse({ error: "COMPETÊNCIA INVÁLIDA." }, 400);
    const totalAmountCents = Math.trunc(Number(body.originalAmountCents));
    if (!Number.isFinite(totalAmountCents) || totalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO." }, 400);
    }
    const customShares = Array.isArray(body.customShares)
      ? (body.customShares as JsonMap[]).map((entry): CustomShareInput => ({
          companyId: safeText(entry.companyId, 80),
          percentBasisPoints: Math.round(Number(entry.percentBasisPoints)),
        }))
      : undefined;

    const database = await getD1();
    const result = await computeRateioShares(database, { model, competenceMonth, totalAmountCents, customShares });
    if ("error" in result) return jsonResponse({ error: result.error }, 409);
    return jsonResponse({ shares: result.shares });
  } catch (error) {
    console.error("Não foi possível calcular a prévia do rateio.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CALCULAR A PRÉVIA DO RATEIO." }, 500);
  }
}
