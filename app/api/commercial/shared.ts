import { getD1 } from "../../../db";
import { canSeeAllStores, hasCompany, type ScopeActor } from "../../lib/access-scope";
import { todayInTimezone } from "../../lib/finance-status";
import {
  computeSellerMetrics,
  isSellerRole,
  monthClock,
  realizedFromEntries,
  type EntryLike,
  type Goal,
  type MonthClock,
  type RealizedTotals,
  type SellerMetrics,
} from "../../lib/commercial";

// Comercial — metas e comissionamento dos vendedores. Permissões próprias
// (MODULE_VIEW_PERMISSIONS.commercial em worker/index.ts), independentes do
// Financeiro e do RH Financeiro:
//   comercial:view   → Dashboard, Comissão e Ranking (só leitura)
//   comercial:manage → tudo acima + cadastro de metas e lançamento do realizado
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

export function canManageCommercial(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("comercial:manage");
}

export function canViewCommercial(actor: Identity) {
  return canManageCommercial(actor) || actor.permissions.includes("comercial:view");
}

/**
 * Alcance de loja do ator — mesma regra de resolveStoreScope(), mas aceitando
 * qualquer uma das duas permissões do módulo como "a permissão da ação"
 * (quem só tem :manage também precisa enxergar o que está lançando).
 * `null` = bloqueado (sem loja e sem permissão).
 */
export function commercialScope(actor: Identity): { allStores: boolean; companyId: string } | null {
  if (canSeeAllStores(actor, "comercial:view") || canSeeAllStores(actor, "comercial:manage")) {
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

type EmployeeRow = {
  id: string;
  fullName: string;
  roleTitle: string;
  companyId: string;
  companyName: string;
  status: string;
};

type GoalRow = Goal & {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  updatedAt: string;
  updatedByName: string;
};

type EntryRow = EntryLike & { employeeId: string };

export type Seller = {
  employeeId: string;
  name: string;
  companyId: string;
  companyName: string;
  active: boolean;
  goal: (Goal & { id: string; updatedAt: string; updatedByName: string }) | null;
  realized: RealizedTotals;
  lastEntryDate: string;
  metrics: SellerMetrics;
};

/**
 * Vendedores do mês + meta + realizado + métricas calculadas ao vivo.
 *
 * Entram: todo funcionário ATIVO cujo cargo contém "vendedor" e, além
 * deles, quem já tem meta ou lançamento no mês (ex.: desligado no meio do
 * mês, ou cargo alterado depois) — pra não sumir número já lançado.
 * A loja do vendedor no mês é a da meta, quando existe (meta é "por
 * loja"); senão, a loja atual do cadastro do funcionário.
 */
export async function loadSellers(database: Database, month: string): Promise<{ sellers: Seller[]; clock: MonthClock }> {
  const [employeesResult, goalsResult, entriesResult, companyNames] = await Promise.all([
    database
      .prepare(
        `SELECT id, full_name AS fullName, role_title AS roleTitle, company_id AS companyId,
                company_name AS companyName, status
         FROM hr_employees`,
      )
      .all<EmployeeRow>(),
    database
      .prepare(
        `SELECT id, employee_id AS employeeId, employee_name AS employeeName, company_id AS companyId,
                company_name AS companyName, target_revenue_cents AS targetRevenueCents,
                target_items AS targetItems, target_warranty_cents AS targetWarrantyCents,
                updated_at AS updatedAt, updated_by_name AS updatedByName
         FROM commercial_goals WHERE month=?1`,
      )
      .bind(month)
      .all<GoalRow>(),
    database
      .prepare(
        `SELECT employee_id AS employeeId, channel, kind, value, entry_date AS entryDate, created_at AS createdAt
         FROM commercial_entries WHERE month=?1`,
      )
      .bind(month)
      .all<EntryRow>(),
    loadCompanyNames(database),
  ]);

  const employees = new Map((employeesResult.results ?? []).map((row) => [row.id, row]));
  const goals = new Map((goalsResult.results ?? []).map((row) => [row.employeeId, row]));
  const entriesByEmployee = new Map<string, EntryRow[]>();
  for (const entry of entriesResult.results ?? []) {
    const list = entriesByEmployee.get(entry.employeeId) ?? [];
    list.push(entry);
    entriesByEmployee.set(entry.employeeId, list);
  }

  const ids = new Set<string>();
  for (const employee of employees.values()) {
    if (employee.status === "active" && isSellerRole(employee.roleTitle)) ids.add(employee.id);
  }
  for (const id of goals.keys()) ids.add(id);
  for (const id of entriesByEmployee.keys()) ids.add(id);

  const clock = monthClock(month, todayInTimezone());
  const sellers: Seller[] = [];
  for (const id of ids) {
    const employee = employees.get(id);
    const goal = goals.get(id) ?? null;
    const entries = entriesByEmployee.get(id) ?? [];
    const companyId = goal?.companyId || employee?.companyId || "";
    const companyName = companyNames.get(companyId) || goal?.companyName || employee?.companyName || "";
    const realized = realizedFromEntries(entries);
    const normalizedGoal = goal
      ? {
          id: goal.id,
          targetRevenueCents: Number(goal.targetRevenueCents) || 0,
          targetItems: Number(goal.targetItems) || 0,
          targetWarrantyCents: Number(goal.targetWarrantyCents) || 0,
          updatedAt: goal.updatedAt,
          updatedByName: goal.updatedByName,
        }
      : null;
    sellers.push({
      employeeId: id,
      name: employee?.fullName || goal?.employeeName || "(funcionário removido)",
      companyId,
      companyName,
      active: employee?.status === "active",
      goal: normalizedGoal,
      realized,
      lastEntryDate: entries.reduce((latest, entry) => (entry.entryDate > latest ? entry.entryDate : latest), ""),
      metrics: computeSellerMetrics(normalizedGoal, realized, clock),
    });
  }
  sellers.sort((a, b) => a.companyName.localeCompare(b.companyName, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"));
  return { sellers, clock };
}

/** Funcionário apto a receber meta/lançamento, respeitando o escopo de loja do ator. */
export async function loadSellerForWrite(
  database: Database,
  actor: Identity,
  employeeId: string,
): Promise<{ error: string; status: number } | { employee: EmployeeRow; companyName: string }> {
  const scope = commercialScope(actor);
  if (!scope) return { error: "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA.", status: 403 };
  const employee = await database
    .prepare(
      `SELECT id, full_name AS fullName, role_title AS roleTitle, company_id AS companyId,
              company_name AS companyName, status
       FROM hr_employees WHERE id=?1 LIMIT 1`,
    )
    .bind(employeeId)
    .first<EmployeeRow>();
  if (!employee) return { error: "VENDEDOR NÃO ENCONTRADO.", status: 404 };
  if (!isSellerRole(employee.roleTitle)) {
    return { error: "ESSE FUNCIONÁRIO NÃO TEM CARGO DE VENDEDOR EM RH > FUNCIONÁRIOS.", status: 400 };
  }
  if (!scope.allStores && employee.companyId !== scope.companyId) {
    return { error: "VOCÊ SÓ PODE LANÇAR DADOS DE VENDEDORES DA SUA LOJA.", status: 403 };
  }
  const companyNames = await loadCompanyNames(database);
  return { employee, companyName: companyNames.get(employee.companyId) || employee.companyName };
}
