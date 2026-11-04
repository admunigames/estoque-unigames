import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// DRE 04/11/2026: custo de funcionário do DEPÓSITO/ESCRITÓRIO rateado entre
// as lojas (padrão RATEIO GRUPO, trocável) e RATEIO POR FUNCIONÁRIOS vindo do
// RH (funcionários atuantes no mês).

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings",
  "hr_terminations", "hr_schedule_assignments", "hr_employee_month_values", "commercial_store_goals", "hr_time_tracking_payouts",
]);
const { loadPayrollDreContribution } = await import("../app/api/finance/dre/payroll.ts");
const { actingHeadcountForMonth, workedInMonth } = await import("../app/lib/acting-store.ts");
const { companyRole } = await import("../app/lib/company-role.ts");
const settingsRoute = await import("../app/api/finance/dre/settings/route.ts");

const ALFA = "clojaalfa1", BETA = "clojabeta1", DEP = "cdeposito1";
const ADMIN = { id: "admin", role: "admin" };
const M = "2030-10";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }, { id: DEP, name: "DEPÓSITO" }]),
});
const emp = (id, company, extra = {}) =>
  db.insert("hr_employees", { id, full_name: id.toUpperCase(), company_id: company, company_name: company, status: "active", cpf: id, ...extra });
emp("a1", ALFA); emp("a2", ALFA); emp("b1", BETA); emp("d1", DEP);
emp("old", BETA, { status: "inactive", admission_date: "2029-01-10" });
db.insert("hr_terminations", { id: "t1", employee_id: "old", termination_date: "2030-09-30" });
emp("novo", BETA, { admission_date: "2030-11-02" });
db.insert("hr_payroll_entries", { id: "pd", month: M, company_id: DEP, company_name: "DEPÓSITO", employee_id: "d1", employee_name: "D1", base_salary_cents: 100001, created_by: "x" });
db.insert("hr_payroll_entries", { id: "pa", month: M, company_id: ALFA, company_name: "LOJA ALFA", employee_id: "a1", employee_name: "A1", base_salary_cents: 50000, created_by: "x" });
db.insert("commercial_store_goals", { id: "ga", month: M, company_id: ALFA, revenue_cents: 75000, assist_revenue_cents: 0 });
db.insert("commercial_store_goals", { id: "gb", month: M, company_id: BETA, revenue_cents: 0, assist_revenue_cents: 25000 });

const folha = async (companyId) => (await loadPayrollDreContribution(globalThis.__routeTestDb, companyId ? { companyId } : "stores", M)).byItem.get("rh-folha") ?? 0;

test("papel da unidade pelo nome e funcionário atuante no mês", async () => {
  assert.deepEqual(["DEPÓSITO", "Escritório Central", "ASSISTÊNCIA TÉCNICA", "RIOMAR"].map(companyRole), ["depot", "office", "assistance", "store"]);
  assert.equal(workedInMonth({ status: "inactive", admissionDate: "2029-01-10" }, "2030-10-05", M), true);
  assert.equal(workedInMonth({ status: "inactive", admissionDate: "2029-01-10" }, "2030-09-30", M), false);
  assert.equal(workedInMonth({ status: "active", admissionDate: "2030-11-02" }, "", M), false);
  const counts = await actingHeadcountForMonth(globalThis.__routeTestDb, M);
  assert.deepEqual([counts.get(ALFA), counts.get(BETA), counts.get(DEP)], [2, 1, 1]);
});

test("RATEIO GRUPO: custo do depósito vai 75%/25% para as lojas; consolidado não muda", async () => {
  assert.equal(await folha(ALFA), 50000 + 75001);
  assert.equal(await folha(BETA), 25000);
  assert.equal(await folha(DEP), 0);
  assert.equal(await folha(""), 150001);
  const detail = await loadPayrollDreContribution(globalThis.__routeTestDb, { companyId: BETA }, M);
  assert.match(detail.blocks[0].label, /RATEIO DEPÓSITO/);
});

test("trocar para FUNCIONÁRIOS (2 x 1) e para UNIGAMES (só vendas)", async () => {
  const bad = await callRoute(settingsRoute.PUT, ADMIN, "PUT", "/api/finance/dre/settings", { overhead: { deposito: "padrao", escritorio: "faturamento" } });
  assert.equal(bad.status, 400);
  const put = await callRoute(settingsRoute.PUT, ADMIN, "PUT", "/api/finance/dre/settings", { overhead: { deposito: "funcionarios", escritorio: "faturamento" } });
  assert.equal(put.status, 200);
  assert.equal(await folha(ALFA), 50000 + 66671); // 66,67% em pontos-base
  assert.equal(await folha(BETA), 33330);
  await callRoute(settingsRoute.PUT, ADMIN, "PUT", "/api/finance/dre/settings", { overhead: { deposito: "faturamento_vendas", escritorio: "faturamento" } });
  assert.equal(await folha(ALFA), 150001);
  assert.equal(await folha(BETA), 0);
  const got = await (await callRoute(settingsRoute.GET, ADMIN, "GET", "/api/finance/dre/settings")).json();
  assert.deepEqual(got.overhead, { deposito: "faturamento_vendas", escritorio: "faturamento" });
});

test("sem peso no mês o custo do depósito fica só nele (e na consolidada)", async () => {
  db.sqlite.prepare("DELETE FROM commercial_store_goals").run();
  assert.equal(await folha(DEP), 100001);
  assert.equal(await folha(ALFA), 50000);
});
