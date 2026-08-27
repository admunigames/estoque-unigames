import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { DATE_PATTERN } from "../../../lib/payables-recurrence";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { loadAccountBalances } from "./shared";

// "Caixa Atual" do Fluxo de Caixa (Financeiro Fase 6): saldo informado
// MANUALMENTE por conta bancária/caixa, com data de referência própria —
// fonte confirmada com o usuário. Contas ATIVAS sem saldo informado voltam
// com hasBalance:false e NÃO entram na soma; a tela as destaca como
// pendência de preenchimento, senão o caixa total mentiria pra baixo sem
// ninguém perceber.
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
    const snapshot = await loadAccountBalances(database, companyId);
    return jsonResponse({ companyId, ...snapshot });
  } catch (error) {
    console.error("Não foi possível carregar os saldos das contas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS SALDOS DAS CONTAS." }, 500);
  }
}

// Upsert do saldo atual de UMA conta. Não há histórico de saldos por decisão
// de escopo (a tabela guarda só o registro "atual" por conta, com auditoria
// mínima de quem informou e quando).
export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR SALDOS DE CONTA." }, 403);
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
    const accountId = safeText(body.accountId, 80);
    const asOfDate = safeText(body.asOfDate, 10);
    const notes = safeText(body.notes, 500);
    const balanceCents = Math.round(Number(body.balanceCents));

    if (!accountId) return jsonResponse({ error: "SELECIONE A CONTA." }, 400);
    // Saldo negativo é legítimo (conta no cheque especial), então só o tipo é
    // validado — não o sinal.
    if (!Number.isFinite(balanceCents)) {
      return jsonResponse({ error: "INFORME UM SALDO VÁLIDO." }, 400);
    }
    if (!DATE_PATTERN.test(asOfDate)) {
      return jsonResponse({ error: "INFORME A DATA DE REFERÊNCIA DO SALDO." }, 400);
    }

    const database = await getD1();
    const account = await database
      .prepare("SELECT id, company_id AS companyId FROM finance_accounts WHERE id=?1")
      .bind(accountId)
      .first<{ id: string; companyId: string }>();
    if (!account) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 400);
    if (!allStores && account.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA CONTA." }, 403);
    }

    await database
      .prepare(
        `INSERT INTO finance_account_balances
          (id, account_id, company_id, balance_cents, as_of_date, notes, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
         ON CONFLICT (account_id) DO UPDATE
           SET company_id = EXCLUDED.company_id,
               balance_cents = EXCLUDED.balance_cents,
               as_of_date = EXCLUDED.as_of_date,
               notes = EXCLUDED.notes,
               updated_by = EXCLUDED.updated_by,
               updated_by_name = EXCLUDED.updated_by_name,
               updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        crypto.randomUUID(),
        accountId,
        account.companyId,
        balanceCents,
        asOfDate,
        notes,
        actor.id,
        actor.displayName || "Administrador",
      )
      .run();

    return jsonResponse({ saved: true, accountId });
  } catch (error) {
    console.error("Não foi possível salvar o saldo da conta.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O SALDO DA CONTA." }, 500);
  }
}
