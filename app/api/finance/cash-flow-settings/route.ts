import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { CASH_FLOW_SETTINGS_COLUMNS, loadEffectiveCashFlowSettings, type CashFlowSettingsRow } from "./shared";

// Configurações de Recebíveis/Fluxo de Caixa (Financeiro Fase 6).
// company_id vazio ('') é a linha GLOBAL, usada como padrão por toda loja que
// não tiver configuração própria — assim o usuário consegue configurar uma
// vez só. Mesma permissão do resto do Financeiro (finance:manage): não foi
// criada permissão nova pra Fase 6.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const requestedCompanyId = safeText(new URL(request.url).searchParams.get("companyId"), 80);
  if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const companyId = allStores ? requestedCompanyId : scopeActor.companyId;

  try {
    const database = await getD1();
    const [effective, rows] = await Promise.all([
      loadEffectiveCashFlowSettings(database, companyId),
      database
        .prepare(`SELECT ${CASH_FLOW_SETTINGS_COLUMNS} FROM finance_cash_flow_settings ORDER BY company_id ASC`)
        .all<CashFlowSettingsRow>(),
    ]);
    return jsonResponse({
      companyId,
      settings: effective,
      // Todas as linhas cadastradas (global + por loja), pra tela conseguir
      // mostrar quem já tem configuração própria. Só quem enxerga todas as
      // lojas recebe a lista completa.
      rows: allStores ? rows.results ?? [] : (rows.results ?? []).filter((row) => row.companyId === companyId || row.companyId === ""),
    });
  } catch (error) {
    console.error("Não foi possível carregar as configurações do fluxo de caixa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CONFIGURAÇÕES DO FLUXO DE CAIXA." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR AS CONFIGURAÇÕES DO FINANCEIRO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const requestedCompanyId = safeText(body.companyId, 80);
    // Só quem enxerga todas as lojas pode gravar a linha global ('') ou a de
    // outra loja — quem está preso a uma loja só configura a própria.
    if (!allStores && requestedCompanyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
    }
    const companyId = allStores ? requestedCompanyId : scopeActor.companyId;

    const toleranceBps = Math.round(Number(body.receivablesToleranceBps));
    const toleranceFixedCents = Math.round(Number(body.receivablesToleranceFixedCents));
    const paymentDay = Math.round(Number(body.payrollDefaultPaymentDay));

    if (!Number.isFinite(toleranceBps) || toleranceBps < 0 || toleranceBps > 10000) {
      return jsonResponse({ error: "INFORME UMA TOLERÂNCIA PERCENTUAL ENTRE 0% E 100%." }, 400);
    }
    if (!Number.isFinite(toleranceFixedCents) || toleranceFixedCents < 0) {
      return jsonResponse({ error: "INFORME UMA TOLERÂNCIA EM VALOR MAIOR OU IGUAL A ZERO." }, 400);
    }
    if (!Number.isFinite(paymentDay) || paymentDay < 1 || paymentDay > 31) {
      return jsonResponse({ error: "INFORME UM DIA DE PAGAMENTO DA FOLHA ENTRE 1 E 31." }, 400);
    }

    const database = await getD1();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO finance_cash_flow_settings
          (id, company_id, receivables_tolerance_bps, receivables_tolerance_fixed_cents,
           payroll_default_payment_day, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
         ON CONFLICT (company_id) DO UPDATE
           SET receivables_tolerance_bps = EXCLUDED.receivables_tolerance_bps,
               receivables_tolerance_fixed_cents = EXCLUDED.receivables_tolerance_fixed_cents,
               payroll_default_payment_day = EXCLUDED.payroll_default_payment_day,
               updated_by = EXCLUDED.updated_by,
               updated_by_name = EXCLUDED.updated_by_name,
               updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(crypto.randomUUID(), companyId, toleranceBps, toleranceFixedCents, paymentDay, actor.id, actorName)
      .run();

    return jsonResponse({ saved: true, companyId });
  } catch (error) {
    console.error("Não foi possível salvar as configurações do fluxo de caixa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR AS CONFIGURAÇÕES DO FLUXO DE CAIXA." }, 500);
  }
}
