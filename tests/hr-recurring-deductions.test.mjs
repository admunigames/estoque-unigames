import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Folha de Pagamento: DESCONTO RECORRENTE (03/11/2026, migration 0124) —
// valor mensal por funcionário, com N meses ou até ENCERRAR, somado ao
// desconto avulso da folha na leitura; não mexe no custo total.

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings", "hr_recurring_deductions",
]);
const route = await import("../app/api/hr-payroll/recurring-deductions/route.ts");
const entries = await import("../app/api/hr-payroll/entries/route.ts");

const ALFA = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("hr_employees", { id: "ana", full_name: "ANA", company_id: ALFA, company_name: "LOJA ALFA", salary_cents: 200000, status: "active", cpf: "1" });
db.insert("hr_payroll_entries", { id: "f10", employee_id: "ana", month: "2026-10", base_salary_cents: 200000, deductions_cents: 5000, created_by: "x" });

const add = (body) => callRoute(route.POST, ADMIN, "POST", "/api/hr-payroll/recurring-deductions", { employeeId: "ana", ...body });
const ana = async (month) => (await (await callRoute(entries.GET, ADMIN, "GET", `/api/hr-payroll/entries?month=${month}`)).json()).entries.find((row) => row.employeeId === "ana");

test("cadastra com N meses (fim calculado) ou sem fim; valida os campos", async () => {
  assert.equal((await add({ description: "x", amountCents: 1000, startMonth: "2026-10" })).status, 400, "descrição curta");
  assert.equal((await add({ description: "EMPRÉSTIMO", amountCents: 0, startMonth: "2026-10" })).status, 400);
  assert.equal((await add({ description: "EMPRÉSTIMO", amountCents: 1000, startMonth: "2026-13" })).status, 400);
  const loan = await (await add({ description: "empréstimo", amountCents: 30000, startMonth: "2026-10", months: 3 })).json();
  assert.equal(loan.endMonth, "2026-12");
  assert.equal((await add({ description: "PLANO ODONTO", amountCents: 4500, startMonth: "2026-11" })).status, 201);
  const list = (await (await callRoute(route.GET, ADMIN, "GET", "/api/hr-payroll/recurring-deductions?employeeId=ana")).json()).deductions;
  assert.deepEqual(list.map((row) => [row.description, row.startMonth, row.endMonth]), [["PLANO ODONTO", "2026-11", ""], ["EMPRÉSTIMO", "2026-10", "2026-12"]]);
});

test("folha soma o recorrente vigente ao avulso; custo total não muda; mês fora do período não desconta", async () => {
  const oct = await ana("2026-10");
  assert.deepEqual([oct.deductionsCents, oct.recurringDeductionsCents, oct.totalDeductionsCents], [5000, 30000, 35000]);
  assert.equal(oct.custoTotalCents, 200000, "desconto não reduz o custo da empresa");
  assert.equal(oct.folhaPagaCents, 200000 - 35000);
  const nov = await ana("2026-11");
  assert.deepEqual([nov.deductionsCents, nov.recurringDeductionsCents], [0, 34500], "sem folha lançada o recorrente já entra");
  assert.equal((await ana("2027-01")).recurringDeductionsCents, 4500, "empréstimo terminou em 12/2026");
  assert.equal((await ana("2026-09")).recurringDeductionsCents, 0);
});

test("ENCERRAR para a partir da competência; EXCLUIR apaga de todos os meses", async () => {
  const [plan] = db.sqlite.prepare("SELECT id FROM hr_recurring_deductions WHERE description='PLANO ODONTO'").all();
  const end = (fromMonth) => callRoute(route.PATCH, ADMIN, "PATCH", "/api/hr-payroll/recurring-deductions", { id: plan.id, fromMonth });
  assert.equal((await end("2026-11")).status, 409, "começa no mesmo mês: usar excluir");
  assert.equal((await end("2027-02")).status, 200);
  assert.equal((await ana("2027-01")).recurringDeductionsCents, 4500);
  assert.equal((await ana("2027-02")).recurringDeductionsCents, 0);
  assert.equal((await end("2027-05")).status, 409, "já terminou antes");
  await callRoute(route.DELETE, ADMIN, "DELETE", `/api/hr-payroll/recurring-deductions?id=${plan.id}`);
  assert.equal((await ana("2026-11")).recurringDeductionsCents, 30000);
});

test("tela: bloco DESCONTOS RECORRENTES no diálogo da folha", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  for (const id of ["rhFolhaRecList", "rhFolhaRecDesc", "rhFolhaRecValor", "rhFolhaRecInicio", "rhFolhaRecMeses", "btnRhFolhaRecAdd"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /DESCONTO AVULSO DO MÊS/);
});
