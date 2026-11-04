import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import {
  canManagePayroll,
  identity,
  jsonResponse,
  loadCnpjTotals,
  loadMonthValues,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  upsertMonthValueStatement,
  type JsonMap,
  type MonthValueKind,
} from "../shared";

// INSS E FGTS POR FUNCIONÁRIO (aba dentro do CUSTO TOTAL POR FUNCIONÁRIO,
// 01/11/2026). Valores DA FOLHA (PDF ou à mão), por competência, gravados em
// hr_employee_month_values — sem tabela nova:
//   'inss' (o mesmo INSS do mês da DRE Funcionário), 'inss_base', 'inss_pct'
//   (porcentagem × 100, só conferência), 'fgts_base' e 'fgts'.
// O INSS e o FGTS daqui alimentam a DRE Funcionário por CNPJ, pela LOJA
// CADASTRADA (admissão) do funcionário. Sem lançamento, FGTS = 0.
// TOTAL DA GUIA POR CNPJ (04/11/2026): INSS e FGTS do mês por CNPJ (kinds
// 'cnpj_inss'/'cnpj_fgts'); lançado, substitui a soma dos funcionários na DRE
// por CNPJ e no total daqui. 0 apaga e volta a valer a soma.

const FIELDS: Array<[keyof Values, MonthValueKind]> = [
  ["inssBaseCents", "inss_base"],
  ["inssPctBps", "inss_pct"],
  ["inssCents", "inss"],
  ["fgtsBaseCents", "fgts_base"],
  ["fgtsCents", "fgts"],
];
type Values = { inssBaseCents: number; inssPctBps: number; inssCents: number; fgtsBaseCents: number; fgtsCents: number };
const MAX_CENTS = 100_000_000;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManagePayroll(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  try {
    const database = await getD1();
    const [employees, companies, cnpjTotals, ...maps] = await Promise.all([
      database
        .prepare(
          `SELECT id, full_name AS fullName, status, COALESCE(NULLIF(admission_company_id, ''), company_id) AS companyId,
                  COALESCE(NULLIF(admission_company_name, ''), company_name) AS companyName
           FROM hr_employees`,
        )
        .all<{ id: string; fullName: string; status: string; companyId: string; companyName: string }>(),
      loadCompanyList(database) as Promise<Array<{ id: string; name: string; cnpj?: string }>>,
      loadCnpjTotals(database, month),
      ...FIELDS.map(([, kind]) => loadMonthValues(database, month, kind)),
    ]);
    const valuesOf = (employeeId: string) =>
      Object.fromEntries(FIELDS.map(([key], index) => [key, maps[index].get(employeeId) ?? 0])) as Values;
    // Ativos + quem tem valor lançado no mês (ex.: desligado no mês).
    const rows = (employees.results ?? [])
      .map((employee) => {
        const company = companies.find((item) => item.id === employee.companyId);
        const values = valuesOf(employee.id);
        return {
          employeeId: employee.id,
          employeeName: employee.fullName,
          companyId: employee.companyId,
          companyName: company?.name || employee.companyName || "",
          cnpj: String(company?.cnpj || "").replace(/\D+/g, ""),
          ...values,
          totalCents: values.inssCents + values.fgtsCents,
          launched: FIELDS.some(([key]) => values[key] > 0),
          active: employee.status === "active",
        };
      })
      .filter((row) => row.active || row.launched);
    const groups = new Map<string, { cnpj: string; companyNames: string[]; rows: typeof rows; inssCents: number; fgtsCents: number; totalCents: number }>();
    for (const row of rows) {
      let group = groups.get(row.cnpj);
      if (!group) groups.set(row.cnpj, (group = { cnpj: row.cnpj, companyNames: [], rows: [], inssCents: 0, fgtsCents: 0, totalCents: 0 }));
      if (row.companyName && !group.companyNames.includes(row.companyName)) group.companyNames.push(row.companyName);
      group.rows.push(row);
      group.inssCents += row.inssCents;
      group.fgtsCents += row.fgtsCents;
      group.totalCents += row.totalCents;
    }
    const ordered = [...groups.values()].sort((a, b) => (!a.cnpj !== !b.cnpj ? (a.cnpj ? -1 : 1) : a.cnpj.localeCompare(b.cnpj)));
    for (const group of ordered) group.rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName, "pt-BR"));
    // Todos os CNPJs cadastrados (com ou sem funcionário), com a soma dos
    // funcionários e o total da guia; o valor da DRE é a guia quando lançada.
    const cnpjNames = new Map<string, string[]>();
    for (const company of companies) {
      const cnpj = String(company.cnpj || "").replace(/\D+/g, "");
      if (!cnpj) continue;
      cnpjNames.set(cnpj, [...(cnpjNames.get(cnpj) ?? []), company.name]);
    }
    for (const group of ordered) if (group.cnpj && !cnpjNames.has(group.cnpj)) cnpjNames.set(group.cnpj, group.companyNames);
    const cnpjs = [...cnpjNames.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cnpj, companyNames]) => {
        const group = groups.get(cnpj);
        const guia = cnpjTotals.get(cnpj) ?? {};
        const employeesInssCents = group?.inssCents ?? 0;
        const employeesFgtsCents = group?.fgtsCents ?? 0;
        const inssCents = guia.inssCents ?? employeesInssCents;
        const fgtsCents = guia.fgtsCents ?? employeesFgtsCents;
        return {
          cnpj, companyNames, employeesInssCents, employeesFgtsCents,
          guiaInssCents: guia.inssCents ?? null, guiaFgtsCents: guia.fgtsCents ?? null,
          inssCents, fgtsCents, totalCents: inssCents + fgtsCents,
        };
      });
    const noCnpj = groups.get("");
    const total = [...cnpjs, ...(noCnpj ? [noCnpj] : [])].reduce(
      (sum, row) => ({ inssCents: sum.inssCents + row.inssCents, fgtsCents: sum.fgtsCents + row.fgtsCents, totalCents: sum.totalCents + row.inssCents + row.fgtsCents }),
      { inssCents: 0, fgtsCents: 0, totalCents: 0 },
    );
    return jsonResponse({ month, groups: ordered, cnpjs, total });
  } catch (error) {
    console.error("Não foi possível carregar o INSS e FGTS do mês.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O INSS E FGTS DO MÊS." }, 500);
  }
}

/** Grava os valores de um ou vários funcionários (PDF ou à mão); 0 apaga o campo. */
export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    const database = await getD1();
    if (Array.isArray(body.cnpjTotals)) return await saveCnpjTotals(database, month, body.cnpjTotals as JsonMap[], actor);
    const values = Array.isArray(body.values) ? (body.values as JsonMap[]) : [];
    if (!values.length || values.length > 1000) return jsonResponse({ error: "INFORME DE 1 A 1000 FUNCIONÁRIOS." }, 400);
    const employees = await database.prepare("SELECT id, full_name AS fullName FROM hr_employees").all<{ id: string; fullName: string }>();
    const names = new Map((employees.results ?? []).map((row) => [row.id, row.fullName]));
    const statements = [];
    for (const [index, entry] of values.entries()) {
      const employeeId = safeText(entry?.employeeId, 80);
      if (!names.has(employeeId)) return jsonResponse({ error: `LINHA ${index + 1}: FUNCIONÁRIO NÃO ENCONTRADO.` }, 400);
      for (const [key, kind] of FIELDS) {
        const amountCents = Number(entry?.[key] ?? 0);
        if (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > MAX_CENTS) {
          return jsonResponse({ error: `LINHA ${index + 1}: VALOR INVÁLIDO.` }, 400);
        }
        statements.push(upsertMonthValueStatement(database, { employeeId, employeeName: names.get(employeeId) ?? "", month, kind, amountCents }, actor));
      }
    }
    await database.batch(statements);
    return jsonResponse({ month, saved: values.length });
  } catch (error) {
    console.error("Não foi possível gravar o INSS e FGTS do mês.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR O INSS E FGTS DO MÊS." }, 500);
  }
}

/** TOTAL DA GUIA por CNPJ: só CNPJ cadastrado em loja; 0 apaga (volta a soma). */
async function saveCnpjTotals(database: Awaited<ReturnType<typeof getD1>>, month: string, entries: JsonMap[], actor: ReturnType<typeof identity>) {
  if (!entries.length || entries.length > 100) return jsonResponse({ error: "INFORME DE 1 A 100 CNPJS." }, 400);
  const companies = (await loadCompanyList(database)) as Array<{ name: string; cnpj?: string }>;
  const names = new Map<string, string[]>();
  for (const company of companies) {
    const cnpj = String(company.cnpj || "").replace(/\D+/g, "");
    if (cnpj) names.set(cnpj, [...(names.get(cnpj) ?? []), company.name]);
  }
  const statements = [];
  for (const [index, entry] of entries.entries()) {
    const cnpj = String(entry?.cnpj ?? "").replace(/\D+/g, "");
    if (!names.has(cnpj)) return jsonResponse({ error: `LINHA ${index + 1}: CNPJ NÃO CADASTRADO EM NENHUMA LOJA.` }, 400);
    for (const [key, kind] of [["inssCents", "cnpj_inss"], ["fgtsCents", "cnpj_fgts"]] as const) {
      const amountCents = Number(entry?.[key] ?? 0);
      if (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > MAX_CENTS) {
        return jsonResponse({ error: `LINHA ${index + 1}: VALOR INVÁLIDO.` }, 400);
      }
      statements.push(upsertMonthValueStatement(database, { employeeId: cnpj, employeeName: (names.get(cnpj) ?? []).join(", "), month, kind, amountCents }, actor));
    }
  }
  await database.batch(statements);
  return jsonResponse({ month, saved: entries.length });
}
