import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// DRE Funcionário — FGTS por colaborador (8% da base de cada um, arredondado
// por pessoa; total do CNPJ = soma) e INSS MANUAL por colaborador (prompt 10,
// 22/10/2026).

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_terminations", "hr_aso_exams", "hr_recruitment_candidates",
  "hr_recruitment_test_payments", "hr_payroll_entries", "hr_commissions",
]);
const { buildCnpjSummary } = await import("../app/lib/hr-employee-dre.ts");
const dre = await import("../app/api/hr-payroll/employee-dre/route.ts");
const monthValues = await import("../app/api/hr-payroll/month-values/route.ts");

const ALFA = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA", cnpj: "11222333000181" }]) });

test("lógica pura: 2.000 e 1.000 → FGTS 160 e 80; arredonda por pessoa", () => {
  const companies = [{ id: ALFA, name: "LOJA ALFA", cnpj: "11222333000181" }];
  const [row] = buildCnpjSummary([], [
    { employeeId: "a", personName: "ANA", companyId: ALFA, salaryCents: 200000, inssCents: 15000 },
    { employeeId: "b", personName: "BIA", companyId: ALFA, salaryCents: 100000 },
  ], companies);
  assert.deepEqual(row.people.map((p) => [p.personName, p.baseCents, p.fgtsCents, p.inssCents]), [["ANA", 200000, 16000, 15000], ["BIA", 100000, 8000, 0]]);
  assert.equal(row.fgtsMonthCents, 24000);
  assert.equal(row.inssCents, 15000);
  assert.equal(row.totalCents, 39000);
  // 8% de R$ 1,06 = 8,48 centavos → 8 por pessoa: CNPJ = 16 (8% do total daria 17).
  const [tiny] = buildCnpjSummary([], [
    { employeeId: "x", personName: "X", companyId: ALFA, salaryCents: 106 },
    { employeeId: "y", personName: "Y", companyId: ALFA, salaryCents: 106 },
  ], companies);
  assert.equal(tiny.fgtsMonthCents, 16);
});

test("rota: base com folha (salário + comissão + HE + DSR), sem folha o cadastro; INSS lançado à mão", async () => {
  const emp = (id, salary) => db.insert("hr_employees", { id, full_name: id.toUpperCase(), company_id: ALFA, company_name: "LOJA ALFA", salary_cents: salary, status: "active", admission_date: "2026-01-01", created_by: "x" });
  emp("ana", 200000);
  emp("bia", 100000);
  emp("caio", 150000);
  db.insert("hr_payroll_entries", { id: "p-caio", month: "2026-10", company_id: ALFA, employee_id: "caio", base_salary_cents: 150000, overtime_cents: 10000, created_by: "x" });
  db.insert("hr_commissions", { id: "c-caio", month: "2026-10", company_id: ALFA, employee_id: "caio", commission_cents: 30000, premiums_cents: 5000, created_by: "x" });
  const put = await callRoute(monthValues.PUT, ADMIN, "PUT", "/api/hr-payroll/month-values", {
    month: "2026-10", kind: "inss", values: [{ employeeId: "ana", amountCents: 16000 }, { employeeId: "bia", amountCents: 7500 }],
  });
  assert.equal(put.status, 200);
  await callRoute(monthValues.PUT, ADMIN, "PUT", "/api/hr-payroll/month-values", { month: "2026-10", kind: "dsr", values: [{ employeeId: "caio", amountCents: 5000 }] });

  const report = await (await callRoute(dre.GET, ADMIN, "GET", "/api/hr-payroll/employee-dre?month=2026-10")).json();
  const row = report.byCnpj.find((item) => item.cnpj === "11222333000181");
  const byName = Object.fromEntries(row.people.map((p) => [p.personName, p]));
  assert.deepEqual([byName.ANA.fgtsCents, byName.BIA.fgtsCents], [16000, 8000]);
  // CAIO: 1.500 + 300 + 50 (premiação) + 100 (HE) + 50 (DSR) = 2.000 → FGTS 160.
  assert.deepEqual([byName.CAIO.baseCents, byName.CAIO.fgtsCents], [200000, 16000]);
  assert.equal(row.fgtsMonthCents, 40000);
  assert.equal(row.inssCents, 23500);
  assert.equal(row.totalCents, 63500);
});

test("tela: botão INSS DO MÊS e lista de colaboradores com base/FGTS/INSS", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="btnRhDreFuncInss"/);
  assert.match(html, /kind:'inss'/);
  assert.match(html, /\['Colaborador','Loja','Base','FGTS \(8%\)','INSS'\]/);
});
