import { getD1 } from "../../../db";
import { canSeeAllStores, hasCompany, type ScopeActor } from "../../lib/access-scope";
import { todayInTimezone } from "../../lib/finance-status";
import {
  DEFAULT_COMMERCIAL_RULES,
  ENTRY_KINDS,
  computeSellerMetrics,
  isEntryKind,
  monthClock,
  resolveCommercialRules,
  type CommercialRules,
  type Goal,
  type MonthClock,
  type Realized,
  type SellerMetrics,
} from "../../lib/commercial";

// Comercial — metas e comissionamento dos vendedores. Permissões próprias
// (MODULE_VIEW_PERMISSIONS.commercial em worker/index.ts), independentes do
// Financeiro e do RH Financeiro:
//   comercial:dashboard  → abas Dashboard e Ranking (sem R$ de comissão)
//   comercial:commission → aba Comissão (valores em R$ da comissão)
//   comercial:goals      → aba Vendedores (metas e realizado do mês) e
//                          marcar NOVATO no Dashboard
//   comercial:credit     → aba Crediários (PAYJOY, CREFAZ, PARCELEX, ODRES,
//                          VENDA P.A, VENDA UNIGAMES)
//   comercial:stores     → aba Meta Loja (meta e feito de cada loja)
//   comercial:rules      → aba Regras de Comissão (percentuais e premiação
//                          por vigência) e marcar NOVATO no Dashboard
// As antigas comercial:view/manage são expandidas na leitura pelo Worker
// (LEGACY_PERMISSION_MAP). Conta vinculada a um vendedor continua vendo só
// os próprios números (ownOnly no overview) — isso vem do vínculo, não da
// permissão.
//
// Escopo por loja: mesma regra de canSeeAllStores() (app/lib/access-scope.ts)
// — admin vê todas; usuário com loja vinculada fica preso à própria loja;
// usuário sem loja com a permissão do módulo vê todas. EXCEÇÃO: o Ranking é
// sempre da empresa inteira, mas só com percentuais (nunca R$).

export type JsonMap = Record<string, unknown>;

export type Identity = ScopeActor & {
  id: string;
  displayName: string;
};

export type Database = Awaited<ReturnType<typeof getD1>>;

export function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

const COMMERCIAL_PERMISSIONS = [
  "comercial:dashboard", "comercial:commission", "comercial:goals", "comercial:rules",
  "comercial:credit", "comercial:stores",
] as const;

function hasCommercialPermission(actor: Identity, permission: (typeof COMMERCIAL_PERMISSIONS)[number]) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

export function canViewCommercialDashboard(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:dashboard");
}

export function canViewCommercialCommission(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:commission");
}

export function canManageCommercialGoals(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:goals");
}

export function canManageCommercialRules(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:rules");
}

export function canManageCommercialCredit(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:credit");
}

export function canManageCommercialStores(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:stores");
}

export function canMarkCommercialNewcomer(actor: Identity) {
  return canManageCommercialGoals(actor) || canManageCommercialRules(actor);
}

export function canAccessCommercial(actor: Identity) {
  return COMMERCIAL_PERMISSIONS.some((permission) => hasCommercialPermission(actor, permission));
}

/**
 * Alcance de loja do ator — mesma regra de resolveStoreScope(), mas aceitando
 * qualquer uma das permissões do módulo como "a permissão da ação" (quem só
 * cadastra metas também precisa enxergar o que está lançando).
 * `null` = bloqueado (sem loja e sem permissão).
 */
export function commercialScope(actor: Identity): { allStores: boolean; companyId: string } | null {
  if (COMMERCIAL_PERMISSIONS.some((permission) => canSeeAllStores(actor, permission))) {
    return { allStores: true, companyId: "" };
  }
  if (hasCompany(actor.companyId)) return { allStores: false, companyId: actor.companyId };
  return null;
}

export function actorName(actor: Identity) {
  return actor.displayName || "Usuário";
}

export function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

export function uuidIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

type CompanyEntry = { id: string; name: string };

/** Nomes atuais das lojas (Cadastros > Lojas), por id. */
export async function loadCompanyNames(database: Database): Promise<Map<string, string>> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  const names = new Map<string, string>();
  try {
    const list = row?.value ? (JSON.parse(row.value) as CompanyEntry[]) : [];
    for (const company of Array.isArray(list) ? list : []) {
      if (company && typeof company.id === "string") names.set(company.id, String(company.name || ""));
    }
  } catch {
    // lista corrompida: cai no company_name desnormalizado
  }
  return names;
}

export type MonthlyRow = Goal & Omit<Realized, "creditSalesCents" | "partnerSalesCents"> & {
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  zone: string;
  updatedAt: string;
  updatedByName: string;
};

export type Seller = {
  employeeId: string;
  name: string;
  companyId: string;
  companyName: string;
  zone: string;
  goal: Goal;
  realized: Realized;
  updatedAt: string;
  updatedByName: string;
  newcomer: boolean;
  metrics: SellerMetrics;
};

export type RulesRow = {
  id: string;
  validFrom: string;
  revenueRateHighBps: number;
  revenueRateLowBps: number;
  premiumTiersJson: string;
  warrantyRateBps: number;
  warrantyAttachTarget: number;
  creditRateBps: number;
  partnerSaleRateBps: number;
  notes: string;
  updatedByName: string;
  updatedAt: string;
};

export function rulesFromRow(row: RulesRow): CommercialRules & { id: string; notes: string; updatedByName: string; updatedAt: string } {
  let premiumTiers = DEFAULT_COMMERCIAL_RULES.premiumTiers;
  try {
    const parsed = JSON.parse(row.premiumTiersJson);
    if (Array.isArray(parsed)) {
      premiumTiers = parsed.map((tier) => ({ percent: Number(tier?.percent) || 0, cents: Number(tier?.cents) || 0 }));
    }
  } catch {
    // JSON corrompido: fica com as faixas padrão
  }
  return {
    id: row.id,
    validFrom: row.validFrom,
    revenueRateHighBps: Number(row.revenueRateHighBps) || 0,
    revenueRateLowBps: Number(row.revenueRateLowBps) || 0,
    premiumTiers,
    warrantyRateBps: Number(row.warrantyRateBps) || 0,
    warrantyAttachTarget: Number(row.warrantyAttachTarget) || 0,
    creditRateBps: Number(row.creditRateBps) || 0,
    partnerSaleRateBps: Number(row.partnerSaleRateBps) || 0,
    notes: row.notes || "",
    updatedByName: row.updatedByName || "",
    updatedAt: row.updatedAt || "",
  };
}

/** Todas as vigências cadastradas, mais recente primeiro (tabela pequena). */
export async function loadRules(database: Database) {
  const result = await database
    .prepare(
      `SELECT id, valid_from AS validFrom, revenue_rate_high_bps AS revenueRateHighBps,
              revenue_rate_low_bps AS revenueRateLowBps, premium_tiers_json AS premiumTiersJson,
              warranty_rate_bps AS warrantyRateBps, warranty_attach_target AS warrantyAttachTarget,
              credit_rate_bps AS creditRateBps, partner_sale_rate_bps AS partnerSaleRateBps, notes, updated_by_name AS updatedByName, updated_at AS updatedAt
       FROM commercial_rules ORDER BY valid_from DESC`,
    )
    .all<RulesRow>();
  return (result.results ?? []).map(rulesFromRow);
}

const MONTHLY_COLUMNS = `
  m.employee_id AS employeeId, m.employee_name AS employeeName, m.company_id AS companyId,
  m.company_name AS companyName, m.zone,
  m.target_revenue_cents AS targetRevenueCents, m.target_items AS targetItems,
  m.target_super_items AS targetSuperItems, m.target_warranty_cents AS targetWarrantyCents,
  m.target_realme AS targetRealme, m.revenue_cents AS revenueCents, m.items,
  m.warranty_cents AS warrantyCents, m.realme, m.warranty_qty AS warrantyQty,
  m.notebook_qty AS notebookQty, m.sales_qty AS salesQty, m.updated_at AS updatedAt, m.updated_by_name AS updatedByName,
  e.full_name AS currentName
`;

const n = (value: unknown) => Number(value) || 0;

/**
 * Vendedores do mês = linhas importadas da planilha, com as métricas já
 * calculadas. Nome atual e loja vêm do cadastro do RH quando o funcionário
 * ainda existe (a loja do RH é a oficial para o escopo).
 */
export async function loadSellers(
  database: Database,
  month: string,
): Promise<{ sellers: Seller[]; clock: MonthClock; rules: CommercialRules }> {
  const [result, companyNames, allRules, newcomersResult, entriesResult] = await Promise.all([
    database
      .prepare(
        `SELECT ${MONTHLY_COLUMNS}, e.company_id AS currentCompanyId
         FROM commercial_monthly m LEFT JOIN hr_employees e ON e.id = m.employee_id
         WHERE m.month=?1`,
      )
      .bind(month)
      .all<MonthlyRow & { currentName: string | null; currentCompanyId: string | null }>(),
    loadCompanyNames(database),
    loadRules(database),
    database
      .prepare("SELECT employee_id AS employeeId FROM commercial_newcomers WHERE month=?1")
      .bind(month)
      .all<{ employeeId: string }>(),
    database
      .prepare(
        `SELECT employee_id AS employeeId, kind, SUM(amount_cents) AS total
         FROM commercial_credit_entries WHERE month=?1 GROUP BY employee_id, kind`,
      )
      .bind(month)
      .all<{ employeeId: string; kind: string; total: number }>(),
  ]);
  const clock = monthClock(month, todayInTimezone());
  const rules = resolveCommercialRules(allRules, month);
  const newcomers = new Set((newcomersResult.results ?? []).map((row) => row.employeeId));
  // Crediário (PAYJOY/CREFAZ/PARCELEX/ODRES) e venda P.A/Unigames do mês, por vendedor.
  const entrySums = new Map<string, { credit: number; partner: number }>();
  for (const row of entriesResult.results ?? []) {
    if (!isEntryKind(row.kind)) continue;
    const sums = entrySums.get(row.employeeId) ?? { credit: 0, partner: 0 };
    sums[ENTRY_KINDS[row.kind].group] += n(row.total);
    entrySums.set(row.employeeId, sums);
  }
  const sellers = (result.results ?? []).map((row): Seller => {
    const goal: Goal = {
      targetRevenueCents: n(row.targetRevenueCents),
      targetItems: n(row.targetItems),
      targetSuperItems: n(row.targetSuperItems),
      targetWarrantyCents: n(row.targetWarrantyCents),
      targetRealme: n(row.targetRealme),
    };
    const realized: Realized = {
      revenueCents: n(row.revenueCents),
      items: n(row.items),
      warrantyCents: n(row.warrantyCents),
      realme: n(row.realme),
      warrantyQty: n(row.warrantyQty),
      notebookQty: n(row.notebookQty),
      salesQty: n(row.salesQty),
      creditSalesCents: entrySums.get(row.employeeId)?.credit ?? 0,
      partnerSalesCents: entrySums.get(row.employeeId)?.partner ?? 0,
    };
    const newcomer = newcomers.has(row.employeeId);
    const companyId = row.currentCompanyId || row.companyId;
    return {
      employeeId: row.employeeId,
      // Nomes de vendedor sempre em CAIXA ALTA no Comercial (telas e imagem).
      name: (row.currentName || row.employeeName || "").toLocaleUpperCase("pt-BR"),
      companyId,
      companyName: companyNames.get(companyId) || row.companyName,
      zone: row.zone,
      goal,
      realized,
      updatedAt: row.updatedAt,
      updatedByName: row.updatedByName,
      newcomer,
      metrics: computeSellerMetrics(goal, realized, clock, rules, newcomer),
    };
  });
  sellers.sort((a, b) => a.companyName.localeCompare(b.companyName, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"));
  return { sellers, clock, rules };
}

/** Funcionários vinculados à conta logada (RH > Funcionários > Conta de acesso). */
export async function linkedEmployeeIds(database: Database, userId: string): Promise<string[]> {
  if (!userId) return [];
  const result = await database
    .prepare("SELECT id FROM hr_employees WHERE user_id=?1")
    .bind(userId)
    .all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}

export type ScopedEmployee = { id: string; fullName: string; companyId: string; companyName: string };

/**
 * Funcionário do RH dentro do alcance de loja de quem lança (null = não
 * existe ou é de outra loja — as rotas respondem o mesmo 404).
 */
export async function employeeInScope(
  database: Database,
  scope: { allStores: boolean; companyId: string },
  employeeId: string,
): Promise<ScopedEmployee | null> {
  if (!employeeId) return null;
  const [employee, companyNames] = await Promise.all([
    database
      .prepare("SELECT id, full_name AS fullName, company_id AS companyId, company_name AS companyName FROM hr_employees WHERE id=?1")
      .bind(employeeId)
      .first<ScopedEmployee>(),
    loadCompanyNames(database),
  ]);
  if (!employee || (!scope.allStores && employee.companyId !== scope.companyId)) return null;
  return { ...employee, companyName: companyNames.get(employee.companyId) || employee.companyName };
}

/** Inteiro ≥ 0 (centavos ou quantidade) — null quando inválido. */
export function nonNegativeInt(value: unknown, max = 2_000_000_000): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

/** "2026-10" → "2026-09". */
export function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 1 ? `${year - 1}-12` : `${year}-${String(monthNumber - 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Comissão do Comercial → RH > Comissionamento (pedido de 2026-10-07).
// A partir desta competência, o campo "comissão" (commission_cents) do
// cabeçalho de cada vendedor do mês é o TOTAL calculado aqui (faturamento +
// premiação + garantia + crediário + venda P.A/Unigames), atualizado a cada
// lançamento no Comercial. Bônus, premiações, descontos e ajustes do RH
// (hr_commission_items) não são tocados. Meses anteriores ficam como o RH
// lançou.
// ---------------------------------------------------------------------------
export const COMMISSION_SYNC_FROM = "2026-10";

/** Vendedores do mês cuja comissão vem do Comercial (vazio antes de COMMISSION_SYNC_FROM). */
export async function commercialEmployeeIds(database: Database, month: string): Promise<Set<string>> {
  if (month < COMMISSION_SYNC_FROM) return new Set();
  const result = await database
    .prepare("SELECT employee_id AS employeeId FROM commercial_monthly WHERE month=?1")
    .bind(month)
    .all<{ employeeId: string }>();
  return new Set((result.results ?? []).map((row) => row.employeeId));
}

/** Total do Comercial para o funcionário no mês — null quando não vem do Comercial. */
export async function commercialCommissionFor(database: Database, employeeId: string, month: string): Promise<number | null> {
  if (month < COMMISSION_SYNC_FROM) return null;
  const { sellers } = await loadSellers(database, month);
  const seller = sellers.find((item) => item.employeeId === employeeId);
  return seller ? seller.metrics.commission.totalCents : null;
}

/**
 * Regrava o "comissão" do RH de todos os vendedores do mês. Vendedor tirado do
 * mês no Comercial NÃO é zerado aqui: o valor fica no RH, que passa a poder
 * editar ou remover (decisão do usuário, 2026-10-07). Falha aqui não desfaz o
 * lançamento do Comercial: fica registrada no log e o próximo lançamento do
 * mês corrige.
 */
export async function syncHrCommissions(database: Database, month: string, actor: Identity) {
  if (month < COMMISSION_SYNC_FROM) return;
  try {
    const [{ sellers }, existing] = await Promise.all([
      loadSellers(database, month),
      database
        .prepare("SELECT id, employee_id AS employeeId FROM hr_commissions WHERE month=?1")
        .bind(month)
        .all<{ id: string; employeeId: string }>(),
    ]);
    const headers = new Map((existing.results ?? []).map((row) => [row.employeeId, row.id]));
    const who = actorName(actor);
    const now = new Date().toISOString();
    const statements = sellers.map((seller) => {
      const id = headers.get(seller.employeeId);
      return id
        ? database
          .prepare("UPDATE hr_commissions SET commission_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=?4 WHERE id=?5")
          .bind(seller.metrics.commission.totalCents, actor.id, who, now, id)
        : database
          .prepare(
            `INSERT INTO hr_commissions
              (id, employee_id, employee_name, company_id, company_name, month, commission_cents,
               bonuses_cents, premiums_cents, discounts_cents, adjustments_cents, notes,
               created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, 0, '', ?8, ?9, ?10, ?8, ?9, ?10)`,
          )
          .bind(
            crypto.randomUUID(), seller.employeeId, seller.name, seller.companyId, seller.companyName, month,
            seller.metrics.commission.totalCents, actor.id, who, now,
          );
    });
    if (statements.length) await database.batch(statements);
  } catch (error) {
    console.error("Não foi possível atualizar a comissão no RH.", error);
  }
}

/** Todos os meses com vendedores a partir de COMMISSION_SYNC_FROM (troca de regra). */
export async function syncHrCommissionsAllMonths(database: Database, actor: Identity) {
  const result = await database
    .prepare("SELECT DISTINCT month FROM commercial_monthly WHERE month>=?1")
    .bind(COMMISSION_SYNC_FROM)
    .all<{ month: string }>();
  for (const row of result.results ?? []) await syncHrCommissions(database, row.month, actor);
}
