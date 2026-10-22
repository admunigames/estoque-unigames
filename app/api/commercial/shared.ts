import { getD1 } from "../../../db";
import { canSeeAllStores, hasCompany, type ScopeActor } from "../../lib/access-scope";
import { todayInTimezone } from "../../lib/finance-status";
import {
  DEFAULT_COMMERCIAL_RULES,
  ENTRY_KINDS,
  computeSellerMetrics,
  digitalCommission,
  isCommercialRole,
  isAssistanceHub,
  isDigitalStore,
  isEntryKind,
  leaderCommission,
  leaderQualifiedSellers,
  monthClock,
  operationalCommission,
  parseRoleRules,
  resolveCommercialRules,
  roleFromTitle,
  type CommercialRole,
  type CommercialRules,
  type Goal,
  type MonthClock,
  type OperationalBreakdown,
  type Realized,
  type SellerMetrics,
  type StoreGoal,
} from "../../lib/commercial";
import { actingStoresForMonth } from "../../lib/acting-store";

// Comercial — metas e comissionamento. Permissões próprias
// (MODULE_VIEW_PERMISSIONS.commercial em worker/index.ts), independentes do
// Financeiro e do RH Financeiro. VER e EDITAR separados por aba (pedido de
// 2026-10-16); quem EDITA também vê:
//   comercial:dashboard  → VER Dashboard (sem R$ de comissão)
//   comercial:commission → VER Comissão (valores em R$ da comissão)
//   comercial:ranking    → VER Ranking
//   comercial:goals_view / comercial:goals   → Vendedores (editar também
//                          marca NOVATO e troca o TIPO)
//   comercial:credit_view / comercial:credit → Crediários
//   comercial:stores_view / comercial:stores → Meta Loja
//   comercial:weekend_view / comercial:weekend → Meta do Fim de Semana
//   comercial:assist_view / comercial:assist → Meta Assistência
//   comercial:rules_view / comercial:rules   → Regras de Comissão (editar
//                          também marca NOVATO)
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
  "comercial:dashboard", "comercial:commission", "comercial:ranking",
  "comercial:goals_view", "comercial:goals", "comercial:credit_view", "comercial:credit",
  "comercial:stores_view", "comercial:stores", "comercial:weekend_view", "comercial:weekend",
  "comercial:assist_view", "comercial:assist", "comercial:rules_view", "comercial:rules",
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

export function canViewCommercialRanking(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:ranking");
}

export function canViewCommercialGoals(actor: Identity) {
  return canManageCommercialGoals(actor) || hasCommercialPermission(actor, "comercial:goals_view");
}

export function canViewCommercialCredit(actor: Identity) {
  return canManageCommercialCredit(actor) || hasCommercialPermission(actor, "comercial:credit_view");
}

export function canViewCommercialStores(actor: Identity) {
  return canManageCommercialStores(actor) || hasCommercialPermission(actor, "comercial:stores_view");
}

export function canManageCommercialWeekend(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:weekend");
}

export function canViewCommercialWeekend(actor: Identity) {
  return canManageCommercialWeekend(actor) || hasCommercialPermission(actor, "comercial:weekend_view");
}

export function canManageCommercialAssist(actor: Identity) {
  return hasCommercialPermission(actor, "comercial:assist");
}

export function canViewCommercialAssist(actor: Identity) {
  return canManageCommercialAssist(actor) || hasCommercialPermission(actor, "comercial:assist_view");
}

export function canViewCommercialRules(actor: Identity) {
  return canManageCommercialRules(actor) || hasCommercialPermission(actor, "comercial:rules_view");
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
  // Tipo no mês. Operacional da aba Vendedores sai de `sellers` e vai para
  // `tabOperationals` (só a aba Vendedores mostra) e `operationals`.
  role: CommercialRole;
  // Funcionário inativo no RH (ou que não existe mais lá). Continua nos
  // cálculos, na comissão/folha e nas abas de cadastro; Dashboard, Ranking e
  // Equipe só o mostram com ?inactive=1 (ver withoutInactive).
  inactive: boolean;
  metrics: SellerMetrics;
};

// OPERACIONAL do mês: ganha pela meta da loja dele (aba Meta Loja). Entra
// sozinho pelo cargo (ativo no RH, com loja) ou pela troca de tipo na aba
// Vendedores. Só existe em vigência com regras de operacional.
export type Operational = {
  employeeId: string;
  name: string;
  companyId: string;
  companyName: string;
  roleTitle: string;
  commission: OperationalBreakdown;
};

/** Esconde os vendedores inativos no RH (padrão do Dashboard/Ranking/Equipe). */
export function withoutInactive<T extends { inactive: boolean }>(sellers: T[], includeInactive: boolean): T[] {
  return includeInactive ? sellers : sellers.filter((seller) => !seller.inactive);
}

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
  rolesJson: string;
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
    // JSON vazio ou corrompido = vigência sem regras de líder/operacional.
    roles: rolesFromJson(row.rolesJson),
    notes: row.notes || "",
    updatedByName: row.updatedByName || "",
    updatedAt: row.updatedAt || "",
  };
}

function rolesFromJson(json: string) {
  if (!json) return null;
  try {
    return parseRoleRules(JSON.parse(json)).roles;
  } catch {
    return null;
  }
}

/** Todas as vigências cadastradas, mais recente primeiro (tabela pequena). */
export async function loadRules(database: Database) {
  const result = await database
    .prepare(
      `SELECT id, valid_from AS validFrom, revenue_rate_high_bps AS revenueRateHighBps,
              revenue_rate_low_bps AS revenueRateLowBps, premium_tiers_json AS premiumTiersJson,
              warranty_rate_bps AS warrantyRateBps, warranty_attach_target AS warrantyAttachTarget,
              credit_rate_bps AS creditRateBps, partner_sale_rate_bps AS partnerSaleRateBps, roles_json AS rolesJson, notes, updated_by_name AS updatedByName, updated_at AS updatedAt
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
  e.full_name AS currentName, e.role_title AS roleTitle
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
): Promise<{ sellers: Seller[]; tabOperationals: Seller[]; operationals: Operational[]; clock: MonthClock; rules: CommercialRules }> {
  const [result, companyNames, allRules, newcomersResult, entriesResult, rolesResult, storeGoals, actingStores] = await Promise.all([
    database
      .prepare(
        `SELECT ${MONTHLY_COLUMNS}, e.company_id AS currentCompanyId, e.status AS currentStatus
         FROM commercial_monthly m LEFT JOIN hr_employees e ON e.id = m.employee_id
         WHERE m.month=?1`,
      )
      .bind(month)
      .all<MonthlyRow & { currentName: string | null; currentCompanyId: string | null; currentStatus: string | null; roleTitle: string | null }>(),
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
    database
      .prepare("SELECT employee_id AS employeeId, role FROM commercial_roles WHERE month=?1")
      .bind(month)
      .all<{ employeeId: string; role: string }>(),
    loadStoreGoals(database, month),
    // Loja atuante de cada um NESTE mês (RH > Funcionários): vale para a meta,
    // o ranking e a premiação do mês — trocar a loja depois não mexe no passado.
    actingStoresForMonth(database, month),
  ]);
  const clock = monthClock(month, todayInTimezone());
  const rules = resolveCommercialRules(allRules, month);
  const overrides = new Map((rolesResult.results ?? [])
    .filter((row) => isCommercialRole(row.role))
    .map((row) => [row.employeeId, row.role as CommercialRole]));
  // Sem regras de líder/operacional na vigência, todo mundo é vendedor.
  const roleOf = (employeeId: string, roleTitle: string | null): CommercialRole =>
    rules.roles ? overrides.get(employeeId) ?? roleFromTitle(roleTitle || "") : "vendedor";
  const newcomers = new Set((newcomersResult.results ?? []).map((row) => row.employeeId));
  // Crediário (PAYJOY/CREFAZ/PARCELEX/ODRES) e venda P.A/Unigames do mês, por vendedor.
  const entrySums = new Map<string, { credit: number; partner: number }>();
  for (const row of entriesResult.results ?? []) {
    if (!isEntryKind(row.kind)) continue;
    const sums = entrySums.get(row.employeeId) ?? { credit: 0, partner: 0 };
    sums[ENTRY_KINDS[row.kind].group] += n(row.total);
    entrySums.set(row.employeeId, sums);
  }
  const roleTitles = new Map<string, string>();
  const everyone = (result.results ?? []).map((row): Seller => {
    roleTitles.set(row.employeeId, row.roleTitle || "");
    const companyId = actingStores.get(row.employeeId)?.companyId || row.currentCompanyId || row.companyId;
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
    return {
      employeeId: row.employeeId,
      // Nomes sempre em CAIXA ALTA no Comercial (telas e imagem).
      name: (row.currentName || row.employeeName || "").toLocaleUpperCase("pt-BR"),
      companyId,
      companyName: companyNames.get(companyId) || row.companyName,
      zone: row.zone,
      goal,
      realized,
      updatedAt: row.updatedAt,
      updatedByName: row.updatedByName,
      newcomer,
      role: roleOf(row.employeeId, row.roleTitle),
      inactive: row.currentStatus !== "active",
      metrics: computeSellerMetrics(goal, realized, clock, rules, newcomer),
    };
  });
  const sellers = everyone.filter((seller) => seller.role !== "operacional");
  const tabOperationals = everyone.filter((seller) => seller.role === "operacional");
  // 2ª passada: o LÍDER depende dos liderados e da meta da loja.
  const roleRules = rules.roles;
  if (roleRules) {
    const team = sellers.map((seller) => ({
      employeeId: seller.employeeId, name: seller.name, companyId: seller.companyId, inactive: seller.inactive,
      role: seller.role, targetRevenueCents: seller.goal.targetRevenueCents, revenueCents: seller.realized.revenueCents,
    }));
    // VENDEDOR DA LOJA DIGITAL: comissão própria (só % do faturamento).
    const digitalRules = roleRules.digital;
    if (digitalRules) {
      for (const seller of sellers) {
        if (seller.role !== "vendedor" || !isDigitalStore(seller.companyName)) continue;
        seller.metrics = { ...seller.metrics, commission: digitalCommission(seller.metrics, digitalRules) };
      }
    }
    for (const seller of sellers) {
      if (seller.role !== "lider") continue;
      seller.metrics = {
        ...seller.metrics,
        commission: leaderCommission(
          seller.metrics, seller.realized, seller.metrics.commission.partnerCommissionCents, roleRules.leader,
          leaderQualifiedSellers(seller, team, roleRules.leader.sellerPercent), storeGoals.get(seller.companyId) ?? null,
        ),
      };
    }
  }
  for (const list of [sellers, tabOperationals]) {
    list.sort((a, b) => a.companyName.localeCompare(b.companyName, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"));
  }
  const operationals = roleRules
    ? (await operationalPeople(
      database, month, roleOf,
      tabOperationals.map(({ employeeId, name, companyId, companyName }) => ({ employeeId, name, companyId, companyName, roleTitle: roleTitles.get(employeeId) || "" })),
      companyNames, new Set(everyone.map((seller) => seller.employeeId)),
    ))
      .map((person): Operational => ({ ...person, commission: operationalCommission(storeGoals.get(person.companyId) ?? null, roleRules.operational) }))
      .sort((a, b) => a.companyName.localeCompare(b.companyName, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"))
    : [];
  return { sellers, tabOperationals, operationals, clock, rules };
}

/**
 * Meta e feito do mês por loja. Desde 2026-10-22 a Meta Loja guarda só
 * VENDAS e a Meta Assistência só a ASSISTÊNCIA: aqui targetCents/revenueCents
 * já são o TOTAL DA LOJA (vendas + assistência), que é o que vale para
 * ranking, comissões e premiações; assist* = só a assistência.
 */
export async function loadStoreGoals(database: Database, month: string): Promise<Map<string, StoreGoal>> {
  const [result, companyNames] = await Promise.all([database
    .prepare(
      `SELECT company_id AS companyId, target_cents AS targetCents, revenue_cents AS revenueCents,
              assist_target_cents AS assistTargetCents, assist_revenue_cents AS assistRevenueCents
       FROM commercial_store_goals WHERE month=?1`,
    )
    .bind(month)
    .all<StoreGoal & { companyId: string }>(), loadCompanyNames(database)]);
  const rows = result.results ?? [];
  // Linha ASSISTÊNCIA: feito = soma da assistência das lojas.
  const assistanceDone = rows.reduce((sum, row) => sum + n(row.assistRevenueCents), 0);
  return new Map(rows.map((row) => [row.companyId, isAssistanceHub(companyNames.get(row.companyId) || "")
    ? { targetCents: n(row.targetCents), revenueCents: assistanceDone, assistTargetCents: 0, assistRevenueCents: 0 }
    : {
      targetCents: n(row.targetCents) + n(row.assistTargetCents), revenueCents: n(row.revenueCents) + n(row.assistRevenueCents),
      assistTargetCents: n(row.assistTargetCents), assistRevenueCents: n(row.assistRevenueCents),
    }]));
}

/**
 * Operacionais do mês: os da aba Vendedores com tipo OPERACIONAL mais os
 * funcionários ATIVOS do RH, com loja, admitidos até o mês, que são
 * operacionais pelo cargo (ou pela troca de tipo) e não estão na aba.
 * ponytail: usa o status ATUAL do RH — quem saiu some dos meses antigos (o
 * valor que já foi para o RH fica lá); guardar o histórico de status se precisar.
 */
async function operationalPeople(
  database: Database,
  month: string,
  roleOf: (employeeId: string, roleTitle: string | null) => CommercialRole,
  fromSellersTab: Array<Omit<Operational, "commission">>,
  companyNames: Map<string, string>,
  inSellersTab: Set<string>,
): Promise<Array<Omit<Operational, "commission">>> {
  const [result, actingStores] = await Promise.all([
    database
      .prepare(
        `SELECT id, full_name AS fullName, role_title AS roleTitle, company_id AS companyId, company_name AS companyName
         FROM hr_employees
         WHERE status='active' AND (admission_date='' OR admission_date<=?1)`,
      )
      .bind(`${month}-31`)
      .all<{ id: string; fullName: string; roleTitle: string; companyId: string; companyName: string }>(),
    actingStoresForMonth(database, month),
  ]);
  const fromRh = (result.results ?? [])
    // Loja do mês = loja atuante (RH > Funcionários), não a de hoje.
    .map((employee) => ({ ...employee, ...(actingStores.get(employee.id) ?? {}) }))
    .filter((employee) => employee.companyId)
    .filter((employee) => !inSellersTab.has(employee.id) && roleOf(employee.id, employee.roleTitle) === "operacional")
    .map((employee) => ({
      employeeId: employee.id,
      name: employee.fullName.toLocaleUpperCase("pt-BR"),
      companyId: employee.companyId,
      companyName: companyNames.get(employee.companyId) || employee.companyName,
      roleTitle: employee.roleTitle,
    }));
  return [...fromSellersTab, ...fromRh];
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

// COMISSÃO (contracheque) e PREMIAÇÃO do Comercial vão SEPARADAS para o RH
// (22/10/2026): commission_cents = comissão; commercial_premium_cents =
// premiação. O total do recibo (a soma) é o mesmo de antes.
type CommercialPayee = {
  employeeId: string;
  name: string;
  companyId: string;
  companyName: string;
  role: CommercialRole;
  commissionCents: number;
  premiumCents: number;
  totalCents: number;
};

/** Vendedores, líderes e operacionais do mês com o que vai para o RH. */
async function commercialPayees(database: Database, month: string): Promise<CommercialPayee[]> {
  const { sellers, operationals } = await loadSellers(database, month);
  return [
    ...sellers.map((seller) => ({
      ...seller,
      commissionCents: seller.metrics.commission.payslipCents,
      premiumCents: seller.metrics.commission.premiumCents,
      totalCents: seller.metrics.commission.totalCents,
    })),
    ...operationals.map((person) => ({
      ...person,
      role: "operacional" as const,
      commissionCents: person.commission.payslipCents,
      premiumCents: person.commission.premiumCents,
      totalCents: person.commission.totalCents,
    })),
  ];
}

/**
 * Quem do mês tem a comissão vinda do Comercial, com o tipo (o recibo do
 * operacional cita DSR/13º/férias/FGTS). Vazio antes de COMMISSION_SYNC_FROM.
 */
export async function commercialEmployeeRoles(database: Database, month: string): Promise<Map<string, CommercialRole>> {
  if (month < COMMISSION_SYNC_FROM) return new Map();
  return new Map((await commercialPayees(database, month)).map((payee) => [payee.employeeId, payee.role]));
}

/** Comissão e premiação do Comercial para o funcionário no mês — null quando não vem do Comercial. */
export async function commercialCommissionFor(
  database: Database,
  employeeId: string,
  month: string,
): Promise<{ commissionCents: number; premiumCents: number } | null> {
  if (month < COMMISSION_SYNC_FROM) return null;
  const payee = (await commercialPayees(database, month)).find((item) => item.employeeId === employeeId);
  return payee ? { commissionCents: payee.commissionCents, premiumCents: payee.premiumCents } : null;
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
    const [payees, existing] = await Promise.all([
      commercialPayees(database, month),
      database
        .prepare("SELECT id, employee_id AS employeeId FROM hr_commissions WHERE month=?1")
        .bind(month)
        .all<{ id: string; employeeId: string }>(),
    ]);
    const headers = new Map((existing.results ?? []).map((row) => [row.employeeId, row.id]));
    const who = actorName(actor);
    const now = new Date().toISOString();
    // Operacional sem valor não ganha cabeçalho novo no RH (são muitos, e o
    // da loja sem meta lançada fica zerado o mês todo).
    const statements = payees.filter((payee) => headers.has(payee.employeeId) || payee.role !== "operacional" || payee.totalCents > 0).map((seller) => {
      const id = headers.get(seller.employeeId);
      return id
        ? database
          .prepare(
            `UPDATE hr_commissions SET commission_cents=?1, commercial_premium_cents=?6, updated_by=?2, updated_by_name=?3, updated_at=?4
             WHERE id=?5`,
          )
          .bind(seller.commissionCents, actor.id, who, now, id, seller.premiumCents)
        : database
          .prepare(
            `INSERT INTO hr_commissions
              (id, employee_id, employee_name, company_id, company_name, month, commission_cents, commercial_premium_cents,
               bonuses_cents, premiums_cents, discounts_cents, adjustments_cents, notes,
               created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?11, 0, 0, 0, 0, '', ?8, ?9, ?10, ?8, ?9, ?10)`,
          )
          .bind(
            crypto.randomUUID(), seller.employeeId, seller.name, seller.companyId, seller.companyName, month,
            seller.commissionCents, actor.id, who, now, seller.premiumCents,
          );
    });
    if (statements.length) await database.batch(statements);
  } catch (error) {
    console.error("Não foi possível atualizar a comissão no RH.", error);
  }
}

/** Todos os meses com vendedores ou metas de loja a partir de COMMISSION_SYNC_FROM (troca de regra). */
export async function syncHrCommissionsAllMonths(database: Database, actor: Identity) {
  const result = await database
    .prepare("SELECT month FROM commercial_monthly WHERE month>=?1 UNION SELECT month FROM commercial_store_goals WHERE month>=?1")
    .bind(COMMISSION_SYNC_FROM)
    .all<{ month: string }>();
  for (const row of result.results ?? []) await syncHrCommissions(database, row.month, actor);
}
