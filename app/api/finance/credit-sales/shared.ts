import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { computeCreditSale, type CreditSaleAmounts } from "../../../lib/credit-sales";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type Identity, type JsonMap } from "../shared";
import { scopeActorOf, type Database, type Statement } from "../card-fees/shared";

// Crediários (Financeiro 7/9) — partes compartilhadas pelas rotas de
// app/api/finance/credit-sales/* e credit-providers. A conta e a situação
// ficam em app/lib/credit-sales.ts.

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type CreditScope = {
  actor: Identity;
  allStores: boolean;
  /** Loja do login (só vale quando allStores = false). */
  companyId: string;
};

/** Sessão + finance:manage (+ mesma origem na escrita) + login com loja; senão a resposta de erro. */
export function creditScope(request: Request, write: boolean): CreditScope | Response {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  if (write && !sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  return { actor, allStores, companyId: scopeActor.companyId };
}

export function inScope(scope: CreditScope, companyId: string): boolean {
  return scope.allStores || companyId === scope.companyId;
}

export function bodyIds(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : []).map((v) => safeText(v, 80)).filter(Boolean))];
}

export type ProviderRow = {
  id: string;
  name: string;
  companyId: string;
  defaultFeeBps: number;
  bankKeyword: string;
  status: string;
  notes: string;
};

export const PROVIDER_COLUMNS = `id, name, company_id AS companyId, default_fee_bps AS defaultFeeBps,
  bank_keyword AS bankKeyword, status, notes`;

/** Financeiras visíveis ao login: as de todas as lojas ('') + as da própria loja. */
export async function loadProviders(database: Database, scope: CreditScope): Promise<ProviderRow[]> {
  const result = await database
    .prepare(`SELECT ${PROVIDER_COLUMNS} FROM finance_credit_providers ORDER BY status ASC, lower(name) ASC`)
    .all<ProviderRow>();
  return (result.results ?? [])
    .filter((row) => !row.companyId || inScope(scope, row.companyId))
    .map((row) => ({ ...row, defaultFeeBps: Number(row.defaultFeeBps || 0) }));
}

export const CREDIT_SALE_COLUMNS = `id, company_id AS companyId, company_name AS companyName, provider_id AS providerId,
  provider_name AS providerName, sale_date AS saleDate, sale_ref AS saleRef, proposal, customer_name AS customerName,
  gross_cents AS grossCents, fee_bps AS feeBps, fee_cents AS feeCents, net_cents AS netCents,
  expected_date AS expectedDate, bank_entry_id AS bankEntryId, received_date AS receivedDate,
  received_cents AS receivedCents, canceled, notes`;

export type CreditSaleRow = CreditSaleAmounts & {
  id: string;
  companyId: string;
  companyName: string;
  providerId: string;
  providerName: string;
  saleDate: string;
  saleRef: string;
  proposal: string;
  customerName: string;
  expectedDate: string;
  bankEntryId: string;
  receivedDate: string;
  receivedCents: number;
  canceled: number;
  notes: string;
};

export function normalizeCreditSale(row: CreditSaleRow): CreditSaleRow {
  return {
    ...row,
    grossCents: Number(row.grossCents || 0),
    feeBps: Number(row.feeBps || 0),
    feeCents: Number(row.feeCents || 0),
    netCents: Number(row.netCents || 0),
    receivedCents: Number(row.receivedCents || 0),
    canceled: Number(row.canceled || 0),
  };
}

export async function loadCreditSalesByIds(database: Database, ids: string[]): Promise<CreditSaleRow[]> {
  if (!ids.length) return [];
  const result = await database
    .prepare(`SELECT ${CREDIT_SALE_COLUMNS} FROM finance_credit_sales WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...ids)
    .all<CreditSaleRow>();
  return (result.results ?? []).map(normalizeCreditSale);
}

export function proposalKey(providerId: string, proposal: string): string {
  return `${providerId}|${proposal.toUpperCase()}`;
}

/** Propostas já cadastradas dessas financeiras (para a 409 e para o lote). */
export async function loadTakenProposals(database: Database, providerIds: string[]): Promise<Set<string>> {
  if (!providerIds.length) return new Set();
  const result = await database
    .prepare(
      `SELECT provider_id AS providerId, proposal FROM finance_credit_sales
       WHERE proposal <> '' AND provider_id IN (${providerIds.map((_, i) => `?${i + 1}`).join(",")})`,
    )
    .bind(...providerIds)
    .all<{ providerId: string; proposal: string }>();
  return new Set((result.results ?? []).map((row) => proposalKey(row.providerId, row.proposal)));
}

export type CreditSaleContext = {
  scope: CreditScope;
  companies: Array<{ id: string; name: string }>;
  providers: Map<string, ProviderRow>;
  taken: Set<string>;
};

/**
 * Confere um crediário novo (NOVO CREDIÁRIO e CADASTRAR EM LOTE) e monta o
 * INSERT. Proposta repetida na mesma financeira → 409 "PROPOSTA JÁ CADASTRADA"
 * (também dentro do próprio lote: a chave entra em ctx.taken).
 */
export function planCreditSale(
  ctx: CreditSaleContext,
  input: JsonMap,
): { statement: Statement; id: string } | { error: string; status: number } {
  const companyId = ctx.scope.allStores ? safeText(input.companyId, 80) : ctx.scope.companyId;
  const company = ctx.companies.find((item) => item.id === companyId);
  if (!hasCompany(companyId) || !company) return { error: "ESCOLHA A UNIDADE.", status: 400 };
  const provider = ctx.providers.get(safeText(input.providerId, 80));
  if (!provider) return { error: "ESCOLHA A FINANCEIRA.", status: 400 };
  if (provider.status !== "active") return { error: "FINANCEIRA INATIVA.", status: 400 };
  if (provider.companyId && provider.companyId !== companyId) return { error: "A FINANCEIRA NÃO ATENDE ESSA UNIDADE.", status: 400 };
  const saleDate = safeText(input.saleDate, 10);
  if (!DATE_RE.test(saleDate)) return { error: "INFORME A DATA DA VENDA.", status: 400 };
  const proposal = safeText(input.proposal, 60).toUpperCase();
  if (!proposal) return { error: "INFORME O Nº DA PROPOSTA.", status: 400 };
  const expectedDate = safeText(input.expectedDate, 10);
  if (expectedDate && !DATE_RE.test(expectedDate)) return { error: "DATA PREVISTA INVÁLIDA.", status: 400 };
  const hasNet = input.netCents !== undefined && input.netCents !== null && input.netCents !== "";
  const amounts = computeCreditSale({
    grossCents: Number(input.grossCents),
    feeBps: input.feeBps === undefined || input.feeBps === null || input.feeBps === "" ? provider.defaultFeeBps : Number(input.feeBps),
    netCents: hasNet ? Number(input.netCents) : null,
  });
  if (!amounts) return { error: "CONFIRA O VALOR COM TAXA, A TAXA E O VALOR SEM TAXA.", status: 400 };
  const key = proposalKey(provider.id, proposal);
  if (ctx.taken.has(key)) return { error: "PROPOSTA JÁ CADASTRADA.", status: 409 };
  ctx.taken.add(key);

  const id = crypto.randomUUID();
  const who = ctx.scope.actor.displayName || "Administrador";
  return {
    id,
    statement: [
      `INSERT INTO finance_credit_sales
         (id, company_id, company_name, provider_id, provider_name, sale_date, sale_ref, proposal, customer_name,
          gross_cents, fee_bps, fee_cents, net_cents, expected_date, notes,
          created_by, created_by_name, updated_by, updated_by_name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?16, ?17)`,
      [
        id,
        companyId,
        company.name,
        provider.id,
        provider.name,
        saleDate,
        safeText(input.saleRef, 60),
        proposal,
        safeText(input.customerName, 80),
        amounts.grossCents,
        amounts.feeBps,
        amounts.feeCents,
        amounts.netCents,
        expectedDate,
        safeText(input.notes, 500),
        ctx.scope.actor.id,
        who,
      ],
    ],
  };
}

/**
 * Devolve para 'pending' (in_dre 1) as entradas do extrato que ficaram sem
 * nenhum crediário apontando para elas. Vai NO FIM do lote (depois dos
 * UPDATE/DELETE dos crediários), na mesma transação.
 */
export function releaseEntryStatements(entryIds: string[], actor: Identity): Statement[] {
  return [...new Set(entryIds.filter(Boolean))].map((entryId) => [
    `UPDATE finance_bank_statement_entries SET status='pending', in_dre=1, updated_by=?2, updated_by_name=?3,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=?1 AND status='credit_sale' AND NOT EXISTS (SELECT 1 FROM finance_credit_sales WHERE bank_entry_id=?1)`,
    [entryId, actor.id, actor.displayName || "Administrador"],
  ]);
}
