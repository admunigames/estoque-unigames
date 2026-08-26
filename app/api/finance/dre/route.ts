import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText } from "../shared";
import { buildByStoreDre, buildConsolidatedDre, buildDreSeries, buildManagerialDre, buildStoreDre } from "./shared";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." },
      403,
    );
  }

  const url = new URL(request.url);
  const scope = safeText(url.searchParams.get("scope"), 20) || "store";

  const VALID_SCOPES = new Set(["store", "consolidated", "managerial", "by-store", "series"]);
  if (!VALID_SCOPES.has(scope)) {
    return jsonResponse({ error: "ESCOPO DE DRE AINDA NÃO DISPONÍVEL." }, 400);
  }

  try {
    const database = await getD1();

    if (scope === "series") {
      const seriesScope = safeText(url.searchParams.get("seriesScope"), 20) === "store" ? "store" : "consolidated";
      const monthFrom = safeText(url.searchParams.get("monthFrom"), 7);
      const monthTo = safeText(url.searchParams.get("monthTo"), 7);
      if (!MONTH_PATTERN.test(monthFrom) || !MONTH_PATTERN.test(monthTo)) {
        return jsonResponse({ error: "INFORME UM PERÍODO VÁLIDO (AAAA-MM ATÉ AAAA-MM)." }, 400);
      }
      if (monthFrom > monthTo) {
        return jsonResponse({ error: "O MÊS INICIAL NÃO PODE SER DEPOIS DO MÊS FINAL." }, 400);
      }
      const storeId = safeText(url.searchParams.get("storeId"), 80);
      if (seriesScope === "store" && !storeId) {
        return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
      }
      const result = await buildDreSeries(database, seriesScope, storeId, monthFrom, monthTo);
      return jsonResponse({ scope, seriesScope, storeId: seriesScope === "store" ? storeId : null, ...result });
    }

    const month = safeText(url.searchParams.get("month"), 7);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    }

    if (scope === "by-store") {
      const result = await buildByStoreDre(database, month);
      return jsonResponse({ scope, month, ...result });
    }

    if (scope === "consolidated") {
      const result = await buildConsolidatedDre(database, month);
      return jsonResponse({ scope, month, ...result });
    }

    if (scope === "managerial") {
      const result = await buildManagerialDre(database, month);
      return jsonResponse({ scope, month, ...result });
    }

    const storeId = safeText(url.searchParams.get("storeId"), 80);
    if (!storeId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    const result = await buildStoreDre(database, storeId, month);
    return jsonResponse({ scope, storeId, month, ...result });
  } catch (error) {
    console.error("Não foi possível montar a DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR A DRE." }, 500);
  }
}
