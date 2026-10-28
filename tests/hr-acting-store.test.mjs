import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// LOJA ATUANTE por mês e LOJA DE ADMISSÃO (prompt 8, 22/10/2026): a loja de
// cada mês (hr_schedule_assignments) vale para Comercial, DRE e Folha; trocar
// a loja não mexe nos meses passados.

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings",
  "hr_terminations", "hr_aso_exams", "app_users",
  "commercial_monthly", "commercial_rules", "commercial_newcomers", "commercial_credit_entries", "commercial_store_goals",
  "commercial_roles",
]);
const { resolveActingStore } = await import("../app/lib/acting-store.ts");
const actingRoute = await import("../app/api/hr-payroll/employees/acting-stores/route.ts");
const employeesRoute = await import("../app/api/hr-payroll/employees/route.ts");
const rankingRoute = await import("../app/api/commercial/ranking/route.ts");
const { loadPayrollDreContribution } = await import("../app/api/finance/dre/payroll.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }]) });
db.insert("hr_employees", {
  id: "e1", full_name: "ANA VENDEDORA", company_id: ALFA, company_name: "LOJA ALFA", role_title: "VENDEDOR", status: "active",
  admission_company_id: ALFA, admission_company_name: "LOJA ALFA", cpf: "1",
});
for (const month of ["2026-10", "2026-11"]) {
  db.insert("hr_payroll_entries", { id: `p-${month}`, month, company_id: ALFA, company_name: "LOJA ALFA", employee_id: "e1", employee_name: "ANA VENDEDORA", base_salary_cents: 200000, created_by: "x" });
  db.insert("commercial_monthly", { id: `m-${month}`, month, employee_id: "e1", employee_name: "ANA VENDEDORA", company_id: ALFA, company_name: "LOJA ALFA", target_revenue_cents: 100, revenue_cents: 100 });
}

const ranking = async (month) =>
  (await (await callRoute(rankingRoute.GET, ADMIN, "GET", `/api/commercial/ranking?month=${month}`)).json()).items.find((item) => item.employeeId === "e1");
const dreFolha = async (companyId, month) =>
  (await loadPayrollDreContribution(globalThis.__routeTestDb, { companyId }, month)).byItem.get("rh-folha") ?? null;

test("resolveActingStore: mês registrado, herda o anterior, sem registro = admissão", () => {
  const admission = { companyId: "a", companyName: "A" };
  const rows = [{ referenceMonth: "2026-11", companyId: "b", companyName: "B" }, { referenceMonth: "2027-02", companyId: "c", companyName: "C" }];
  assert.equal(resolveActingStore(rows, "2026-10", admission).companyId, "a");
  assert.equal(resolveActingStore(rows, "2026-11", admission).companyId, "b");
  assert.equal(resolveActingStore(rows, "2027-01", admission).companyId, "b");
  assert.equal(resolveActingStore(rows, "2027-03", admission).companyId, "c");
  assert.equal(resolveActingStore([], "2026-10", admission).companyId, "a");
});

test("só admitido numa loja: sem mês lançado vale a loja atuante do cadastro, não a de admissão", async () => {
  const current = { companyId: "r", companyName: "RIOMAR" };
  assert.equal(resolveActingStore([], "2026-10", { companyId: "p", companyName: "PATTEO" }, current).companyId, "r");
  db.insert("hr_employees", {
    id: "e9", full_name: "ASAFE", company_id: BETA, company_name: "LOJA BETA", status: "active",
    admission_company_id: ALFA, admission_company_name: "LOJA ALFA", cpf: "9",
  });
  db.insert("commercial_monthly", { id: "m-e9", month: "2026-10", employee_id: "e9", employee_name: "ASAFE", company_id: ALFA, company_name: "LOJA ALFA", target_revenue_cents: 100, revenue_cents: 100 });
  const item = (await (await callRoute(rankingRoute.GET, ADMIN, "GET", "/api/commercial/ranking?month=2026-10")).json()).items.find((row) => row.employeeId === "e9");
  assert.equal(item.companyName, "LOJA BETA");
});

test("muda de loja em novembro → outubro continua na loja antiga no Comercial e na DRE", async () => {
  const response = await callRoute(actingRoute.PUT, ADMIN, "PUT", "/api/hr-payroll/employees/acting-stores", { employeeId: "e1", month: "2026-11", companyId: BETA });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));

  assert.equal((await ranking("2026-10")).companyName, "LOJA ALFA");
  assert.equal((await ranking("2026-11")).companyName, "LOJA BETA");

  assert.equal(await dreFolha(ALFA, "2026-10"), 200000);
  assert.equal(await dreFolha(BETA, "2026-10"), null);
  assert.equal(await dreFolha(BETA, "2026-11"), 200000);
  assert.equal(await dreFolha(ALFA, "2026-11"), null);

  // Lançamentos da Folha acompanham a loja do mês; outubro fica onde estava.
  const entries = db.sqlite.prepare("SELECT month, company_id AS companyId FROM hr_payroll_entries ORDER BY month").all();
  assert.deepEqual(entries.map((row) => [row.month, row.companyId]), [["2026-10", ALFA], ["2026-11", BETA]]);

  const months = await (await callRoute(actingRoute.GET, ADMIN, "GET", "/api/hr-payroll/employees/acting-stores?employeeId=e1")).json();
  assert.deepEqual(months.months.map((row) => [row.month, row.companyId]), [["2026-11", BETA]]);

  // Remover o mês volta novembro para a loja de admissão.
  const removed = await callRoute(actingRoute.DELETE, ADMIN, "DELETE", "/api/hr-payroll/employees/acting-stores?employeeId=e1&month=2026-11");
  assert.equal(removed.status, 200);
  assert.equal((await ranking("2026-11")).companyName, "LOJA ALFA");
  assert.equal(db.sqlite.prepare("SELECT company_id AS c FROM hr_payroll_entries WHERE month='2026-11'").get().c, ALFA);
});

test("trocar a loja no cadastro vale do mês corrente em diante; loja de admissão fica gravada", async () => {
  db.insert("hr_employees", {
    id: "e2", full_name: "BRUNO", company_id: ALFA, company_name: "LOJA ALFA", status: "active",
    admission_company_id: ALFA, admission_company_name: "LOJA ALFA", cpf: "2",
  });
  db.insert("hr_payroll_entries", { id: "p-e2-old", month: "2026-01", company_id: ALFA, company_name: "LOJA ALFA", employee_id: "e2", employee_name: "BRUNO", base_salary_cents: 100000, created_by: "x" });
  const response = await callRoute(employeesRoute.POST, ADMIN, "POST", "/api/hr-payroll/employees", { id: "e2", fullName: "BRUNO", companyId: BETA, status: "active" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const employee = db.sqlite.prepare("SELECT company_id AS c, admission_company_id AS a FROM hr_employees WHERE id='e2'").get();
  assert.deepEqual([employee.c, employee.a], [BETA, ALFA]);
  assert.equal(db.sqlite.prepare("SELECT company_id AS c FROM hr_payroll_entries WHERE id='p-e2-old'").get().c, ALFA);
  assert.equal(await dreFolha(ALFA, "2026-01"), 100000);
  const assignment = db.sqlite.prepare("SELECT company_id AS c FROM hr_schedule_assignments WHERE employee_id='e2'").get();
  assert.equal(assignment.c, BETA);
});

test("tela: LOJA DE ADMISSÃO e tabela LOJA ATUANTE POR MÊS no cadastro", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="rhEmployeeAdmissionCompany"/);
  assert.match(html, /LOJA ATUANTE POR MÊS/);
  assert.match(html, /\/employees\/acting-stores/);
  assert.match(html, /admissionCompanyId: el\('rhEmployeeAdmissionCompany'\)/);
});
