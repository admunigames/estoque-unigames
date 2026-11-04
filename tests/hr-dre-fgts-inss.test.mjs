import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// DRE Funcionário — FGTS por colaborador (8% da base de cada um, arredondado
// por pessoa; total do CNPJ = soma) e INSS MANUAL por colaborador (prompt 10,
// 22/10/2026).

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_terminations", "hr_aso_exams", "hr_recruitment_candidates",
  "hr_recruitment_test_payments", "hr_payroll_entries", "hr_commissions", "hr_vacations",
]);
const { buildCnpjSummary } = await import("../app/lib/hr-employee-dre.ts");
const dre = await import("../app/api/hr-payroll/employee-dre/route.ts");
const monthValues = await import("../app/api/hr-payroll/month-values/route.ts");
const inssFgts = await import("../app/api/hr-payroll/inss-fgts/route.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA", cnpj: "11222333000181" }, { id: BETA, name: "LOJA BETA" }]) });

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

// Desde 01/11/2026 o INSS e o FGTS por CNPJ vêm da aba INSS E FGTS (valores da
// folha, pela LOJA CADASTRADA); sem lançamento, FGTS = 0. A base segue informativa.
test("rota: INSS/FGTS da folha pela loja cadastrada; sem lançamento FGTS = 0; base com folha", async () => {
  const emp = (id, salary, extra = {}) => db.insert("hr_employees", { id, full_name: id.toUpperCase(), company_id: ALFA, company_name: "LOJA ALFA", salary_cents: salary, status: "active", admission_date: "2026-01-01", created_by: "x", ...extra });
  emp("ana", 200000);
  emp("bia", 100000);
  emp("caio", 150000);
  // Atua na BETA (sem CNPJ), mas é registrado na ALFA: INSS/FGTS vão para o CNPJ da ALFA.
  emp("davi", 183200, { company_id: BETA, company_name: "LOJA BETA", admission_company_id: ALFA, admission_company_name: "LOJA ALFA" });
  db.insert("hr_payroll_entries", { id: "p-caio", month: "2026-10", company_id: ALFA, employee_id: "caio", base_salary_cents: 150000, overtime_cents: 10000, created_by: "x" });
  db.insert("hr_commissions", { id: "c-caio", month: "2026-10", company_id: ALFA, employee_id: "caio", commission_cents: 30000, premiums_cents: 5000, created_by: "x" });
  await callRoute(monthValues.PUT, ADMIN, "PUT", "/api/hr-payroll/month-values", { month: "2026-10", kind: "dsr", values: [{ employeeId: "caio", amountCents: 5000 }] });
  // Exemplo da folha: base 1.832,00 · INSS 7,67% = 140,56 · FGTS 146,56 · total 287,12.
  const put = await callRoute(inssFgts.PUT, ADMIN, "PUT", "/api/hr-payroll/inss-fgts", { month: "2026-10", values: [
    { employeeId: "davi", inssBaseCents: 183200, inssPctBps: 767, inssCents: 14056, fgtsBaseCents: 183200, fgtsCents: 14656 },
    { employeeId: "ana", inssCents: 16000, fgtsCents: 16000 },
  ] });
  assert.equal(put.status, 200, JSON.stringify(await put.clone().json()));
  assert.equal((await callRoute(inssFgts.PUT, ADMIN, "PUT", "/api/hr-payroll/inss-fgts", { month: "2026-10", values: [{ employeeId: "x", inssCents: 1 }] })).status, 400);
  assert.equal((await callRoute(inssFgts.PUT, { id: "loja", permissions: [] }, "PUT", "/api/hr-payroll/inss-fgts", { month: "2026-10", values: [{ employeeId: "ana", inssCents: 1 }] })).status, 403);

  const tab = await (await callRoute(inssFgts.GET, ADMIN, "GET", "/api/hr-payroll/inss-fgts?month=2026-10")).json();
  const alfa = tab.groups.find((group) => group.cnpj === "11222333000181");
  const davi = alfa.rows.find((row) => row.employeeId === "davi");
  assert.deepEqual([davi.inssBaseCents, davi.inssPctBps, davi.inssCents, davi.fgtsBaseCents, davi.fgtsCents, davi.totalCents], [183200, 767, 14056, 183200, 14656, 28712]);
  assert.equal(Math.round(davi.inssBaseCents * davi.inssPctBps / 10000), 14051, "a % é só conferência; vale o INSS da folha");
  assert.deepEqual([alfa.inssCents, alfa.fgtsCents, alfa.totalCents], [30056, 30656, 60712]);
  assert.deepEqual(tab.total, { inssCents: 30056, fgtsCents: 30656, totalCents: 60712 });

  const report = await (await callRoute(dre.GET, ADMIN, "GET", "/api/hr-payroll/employee-dre?month=2026-10")).json();
  const row = report.byCnpj.find((item) => item.cnpj === "11222333000181");
  const byName = Object.fromEntries(row.people.map((p) => [p.personName, p]));
  assert.deepEqual([byName.ANA.fgtsCents, byName.BIA.fgtsCents, byName.DAVI.fgtsCents], [16000, 0, 14656]);
  // CAIO: 1.500 + 300 + 50 (premiação) + 100 (HE) = 1.950 de base (o DSR saiu em 04/11/2026); sem lançamento, FGTS 0.
  assert.deepEqual([byName.CAIO.baseCents, byName.CAIO.fgtsCents], [195000, 0]);
  assert.equal(row.fgtsMonthCents, 30656);
  assert.equal(row.inssCents, 30056);
  // O INSS DO MÊS da DRE e o da aba são o mesmo valor (kind 'inss'), sem duplicar.
  const inssDoMes = await (await callRoute(monthValues.GET, ADMIN, "GET", "/api/hr-payroll/month-values?month=2026-10&kind=inss")).json();
  assert.equal(inssDoMes.values.length, 2);
});

// TOTAL DA GUIA POR CNPJ (04/11/2026): lançado, substitui a soma dos funcionários.
test("rota: total da guia por CNPJ substitui a soma; 0 volta à soma; CNPJ precisa existir", async () => {
  const save = (body, actor = ADMIN) => callRoute(inssFgts.PUT, actor, "PUT", "/api/hr-payroll/inss-fgts", { month: "2026-10", ...body });
  assert.equal((await save({ cnpjTotals: [{ cnpj: "99888777000100", inssCents: 1 }] })).status, 400);
  assert.equal((await save({ cnpjTotals: [{ cnpj: "11222333000181", inssCents: 1 }] }, { id: "loja", permissions: [] })).status, 403);
  // Só o INSS da guia: o FGTS continua a soma dos funcionários (30.656).
  assert.equal((await save({ cnpjTotals: [{ cnpj: "11.222.333/0001-81", inssCents: 50000, fgtsCents: 0 }] })).status, 200);
  const tab = await (await callRoute(inssFgts.GET, ADMIN, "GET", "/api/hr-payroll/inss-fgts?month=2026-10")).json();
  const alfa = tab.cnpjs.find((row) => row.cnpj === "11222333000181");
  assert.deepEqual([alfa.employeesInssCents, alfa.guiaInssCents, alfa.inssCents, alfa.guiaFgtsCents, alfa.fgtsCents], [30056, 50000, 50000, null, 30656]);
  assert.deepEqual(tab.total, { inssCents: 50000, fgtsCents: 30656, totalCents: 80656 });
  const dreRow = async () => (await (await callRoute(dre.GET, ADMIN, "GET", "/api/hr-payroll/employee-dre?month=2026-10")).json()).byCnpj.find((item) => item.cnpj === "11222333000181");
  assert.deepEqual([(await dreRow()).inssCents, (await dreRow()).fgtsMonthCents], [50000, 30656]);
  await save({ cnpjTotals: [{ cnpj: "11222333000181", inssCents: 0, fgtsCents: 0 }] });
  assert.equal((await dreRow()).inssCents, 30056, "sem guia, volta a soma dos funcionários");
});

test("tela: botão INSS DO MÊS e fechamento compacto com INSS/FGTS por CNPJ", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="btnRhDreFuncInss"/);
  assert.match(html, /kind:'inss'/);
  // Fechamento compacto (31/10/2026): bloco INSS / FGTS por CNPJ.
  assert.match(html, /block\('INSS \/ FGTS'/);
  assert.match(html, /li\('INSS — '\+money\(row\.inssCents\)\), li\('FGTS — '\+money\(row\.fgtsMonthCents\)\)/);
  // Aba INSS E FGTS dentro do CUSTO TOTAL POR FUNCIONÁRIO; treinamento do recrutamento fora da DRE.
  assert.match(html, /data-rh-custo-tab="inss">INSS E FGTS</);
  assert.match(html, /id="rhInssFgtsDialog"/);
  assert.match(html, /rhApiRequest\('\/inss-fgts\?month='/);
  assert.doesNotMatch(html, /block\('TREINAMENTOS'/);
});
