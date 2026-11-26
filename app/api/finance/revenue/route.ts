import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
} from "../shared";
import { loadDreRevenueByStore } from "./commercial";

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
  const storeId = safeText(url.searchParams.get("storeId"), 80);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!storeId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }

  try {
    const database = await getD1();
    // Receita da DRE = Comercial; SERVIÇOS das lojas vão para a DRE da ASSISTÊNCIA (26/11/2026).
    const revenue = (await loadDreRevenueByStore(database, month)).get(storeId) ??
      { salesCents: 0, servicesCents: 0, amountCents: 0, updatedAt: "", updatedByName: "", isHub: false, servicesToHubCents: 0 };
    return jsonResponse({
      revenue: {
        storeId,
        month,
        amountCents: revenue.amountCents,
        salesAmountCents: revenue.salesCents,
        servicesAmountCents: revenue.servicesCents,
        assistanceHub: revenue.isHub,
        servicesToAssistanceCents: revenue.servicesToHubCents,
        updatedAt: revenue.updatedAt,
        updatedByName: revenue.updatedByName,
        source: "commercial",
      },
    });
  } catch (error) {
    console.error("Não foi possível carregar a receita financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A RECEITA." }, 500);
  }
}

// A receita não é mais digitada na DRE: vem do Comercial (Meta Loja / Meta
// Assistência). Mantido só para responder a telas antigas abertas.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  return jsonResponse(
    { error: "A RECEITA DA DRE VEM DO COMERCIAL (META LOJA E META ASSISTÊNCIA) — ATUALIZE O FEITO NO COMERCIAL." },
    410,
  );
}
