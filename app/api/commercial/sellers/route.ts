import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN, isSellerRole } from "../../../lib/commercial";
import {
  actorName,
  canManageCommercialGoals,
  commercialScope,
  employeeInScope,
  identity,
  jsonResponse,
  loadCompanyNames,
  nonNegativeInt,
  previousMonth,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Aba Vendedores (comercial:goals): metas e realizado do mês de cada
// vendedor, lançados à mão e ao vivo (substitui a importação da planilha).
// Escopo de loja de sempre (commercialScope): gestor com loja só lança os
// vendedores da própria loja. Cada mês é uma linha por vendedor em
// commercial_monthly — virar o mês não apaga nada.
//   GET    ?month        → funcionários do RH que podem ser adicionados
//   PUT    {month, employeeId, zone, ...números} → cria/atualiza a linha
//   POST   {month}       → copia vendedores, zona e metas do mês anterior
//                          (só quem ainda não está no mês; realizado zerado)
//   DELETE ?month&employeeId → tira o vendedor do mês

// Campo do corpo → coluna. Valores em R$ em centavos, o resto em quantidade.
const NUMBER_FIELDS = [
  ["targetRevenueCents", "target_revenue_cents"],
  ["targetItems", "target_items"],
  ["targetSuperItems", "target_super_items"],
  ["targetWarrantyCents", "target_warranty_cents"],
  ["targetRealme", "target_realme"],
  ["revenueCents", "revenue_cents"],
  ["items", "items"],
  ["warrantyCents", "warranty_cents"],
  ["realme", "realme"],
  ["warrantyQty", "warranty_qty"],
  ["notebookQty", "notebook_qty"],
  ["salesQty", "sales_qty"],
] as const;
const ZONES = ["", "NORTE", "SUL"];

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManageCommercialGoals(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR OS VENDEDORES." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) {
    return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  }
  const scope = commercialScope(actor);
  if (!scope) return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  return { actor, scope };
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { scope } = checked;
  try {
    const database = await getD1();
    const [result, companyNames] = await Promise.all([
      database
        .prepare(
          `SELECT id, full_name AS fullName, role_title AS roleTitle, company_id AS companyId,
                  company_name AS companyName
           FROM hr_employees WHERE status='active' ORDER BY full_name ASC`,
        )
        .all<{ id: string; fullName: string; roleTitle: string; companyId: string; companyName: string }>(),
      loadCompanyNames(database),
    ]);
    const employees = (result.results ?? [])
      .filter((employee) => scope.allStores || employee.companyId === scope.companyId)
      .map((employee) => ({
        id: employee.id,
        fullName: employee.fullName.toLocaleUpperCase("pt-BR"),
        companyId: employee.companyId,
        companyName: companyNames.get(employee.companyId) || employee.companyName,
        isSeller: isSellerRole(employee.roleTitle),
      }));
    return jsonResponse({ employees });
  } catch (error) {
    console.error("Não foi possível carregar os funcionários do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS FUNCIONÁRIOS." }, 500);
  }
}

export async function PUT(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const month = safeText(body.month, 7);
    const zone = safeText(body.zone, 10).toUpperCase();
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
    if (!ZONES.includes(zone)) return jsonResponse({ error: "ZONA INVÁLIDA." }, 400);
    const values: number[] = [];
    for (const [field] of NUMBER_FIELDS) {
      const value = nonNegativeInt(body[field] ?? 0);
      if (value === null) return jsonResponse({ error: "OS NÚMEROS PRECISAM SER POSITIVOS (OU ZERO)." }, 400);
      values.push(value);
    }
    const database = await getD1();
    const employee = await employeeInScope(database, scope, safeText(body.employeeId, 80));
    if (!employee) return jsonResponse({ error: "VENDEDOR NÃO ENCONTRADO." }, 404);
    const columns = NUMBER_FIELDS.map(([, column]) => column);
    // ?1..?12 = números; depois id, funcionário, loja, zona, mês, quem.
    const base = columns.length;
    await database
      .prepare(
        `INSERT INTO commercial_monthly
          (${columns.join(", ")}, id, employee_id, employee_name, company_id, company_name, zone, month,
           updated_by, updated_by_name, updated_at)
         VALUES (${columns.map((_, index) => `?${index + 1}`).join(", ")},
                 ?${base + 1}, ?${base + 2}, ?${base + 3}, ?${base + 4}, ?${base + 5}, ?${base + 6}, ?${base + 7},
                 ?${base + 8}, ?${base + 9}, ?${base + 10})
         ON CONFLICT (employee_id, month) DO UPDATE SET
           ${columns.map((column) => `${column}=excluded.${column}`).join(", ")},
           employee_name=excluded.employee_name, company_id=excluded.company_id,
           company_name=excluded.company_name, zone=excluded.zone, updated_by=excluded.updated_by,
           updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at`,
      )
      .bind(
        ...values,
        crypto.randomUUID(), employee.id, employee.fullName, employee.companyId, employee.companyName, zone, month,
        actor.id, actorName(actor), new Date().toISOString(),
      )
      .run();
    return jsonResponse({ employeeId: employee.id, month });
  } catch (error) {
    console.error("Não foi possível salvar o vendedor do mês.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O VENDEDOR." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const month = safeText(body.month, 7);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
    const database = await getD1();
    const from = previousMonth(month);
    const [previous, current] = await Promise.all([
      database
        .prepare(
          `SELECT m.employee_id AS employeeId, m.employee_name AS employeeName, m.zone,
                  m.target_revenue_cents AS targetRevenueCents, m.target_items AS targetItems,
                  m.target_super_items AS targetSuperItems, m.target_warranty_cents AS targetWarrantyCents,
                  m.target_realme AS targetRealme, e.company_id AS companyId, e.company_name AS companyName,
                  e.full_name AS fullName, e.status
           FROM commercial_monthly m JOIN hr_employees e ON e.id = m.employee_id WHERE m.month=?1`,
        )
        .bind(from)
        .all<Record<string, string | number>>(),
      database.prepare("SELECT employee_id AS employeeId FROM commercial_monthly WHERE month=?1").bind(month).all<{ employeeId: string }>(),
    ]);
    const already = new Set((current.results ?? []).map((row) => row.employeeId));
    const companyNames = await loadCompanyNames(database);
    const toCopy = (previous.results ?? []).filter((row) =>
      row.status === "active" && !already.has(String(row.employeeId)) &&
      (scope.allStores || row.companyId === scope.companyId));
    if (!toCopy.length) return jsonResponse({ copied: 0 });
    const now = new Date().toISOString();
    await database.batch(toCopy.map((row) =>
      database
        .prepare(
          `INSERT INTO commercial_monthly
            (id, employee_id, employee_name, company_id, company_name, zone, month, target_revenue_cents,
             target_items, target_super_items, target_warranty_cents, target_realme,
             updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
        )
        .bind(
          crypto.randomUUID(), row.employeeId, row.fullName, row.companyId,
          companyNames.get(String(row.companyId)) || row.companyName, row.zone, month,
          row.targetRevenueCents, row.targetItems, row.targetSuperItems, row.targetWarrantyCents, row.targetRealme,
          actor.id, actorName(actor), now,
        ),
    ));
    return jsonResponse({ copied: toCopy.length }, 201);
  } catch (error) {
    console.error("Não foi possível copiar os vendedores do mês anterior.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL COPIAR O MÊS ANTERIOR." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { scope } = checked;
  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    const employee = await employeeInScope(database, scope, safeText(url.searchParams.get("employeeId"), 80));
    if (!employee) return jsonResponse({ error: "VENDEDOR NÃO ENCONTRADO." }, 404);
    await database
      .prepare("DELETE FROM commercial_monthly WHERE employee_id=?1 AND month=?2")
      .bind(employee.id, month)
      .run();
    return jsonResponse({ employeeId: employee.id, month });
  } catch (error) {
    console.error("Não foi possível tirar o vendedor do mês.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL TIRAR O VENDEDOR DO MÊS." }, 500);
  }
}
