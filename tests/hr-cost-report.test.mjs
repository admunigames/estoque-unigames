import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Folha só com o CUSTO TOTAL + relatório CUSTO TOTAL POR FUNCIONÁRIO com DSR
// MANUAL (prompt 9, 22/10/2026).

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings", "hr_recurring_deductions",
]);
const { computeEmployeeCost, sumEmployeeCosts } = await import("../app/lib/hr-cost-report.ts");
const monthValuesRoute = await import("../app/api/hr-payroll/month-values/route.ts");
const costRoute = await import("../app/api/hr-payroll/cost-report/route.ts");
const entriesRoute = await import("../app/api/hr-payroll/entries/route.ts");
const { loadPayrollDreContribution } = await import("../app/api/finance/dre/payroll.ts");

const ALFA = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
const RH_ONLY = { id: "rh", permissions: ["payroll:manage"] };
const RH_FIN = { id: "rhfin", permissions: ["payroll:manage", "finance:view"] };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("hr_employees", { id: "alex", full_name: "ALEXANDRE", company_id: ALFA, company_name: "LOJA ALFA", salary_cents: 164800, status: "active", cpf: "1" });
db.insert("hr_employees", { id: "bia", full_name: "BIA", company_id: ALFA, company_name: "LOJA ALFA", salary_cents: 100000, status: "active", cpf: "2" });
db.insert("hr_commissions", { id: "c1", month: "2026-10", company_id: ALFA, employee_id: "alex", commission_cents: 176000, created_by: "x" });

test("fórmulas conferidas com a planilha (linha ALEXANDRE)", () => {
  // O DSR saiu em 04/11/2026: a linha da planilha entra com o DSR somado na comissão (mesma remuneração).
  const cost = computeEmployeeCost({ baseSalaryCents: 164800, commissionCents: 176000 + 65538, overtimeCents: 0 });
  assert.equal(cost.remunerationCents, 406338);
  assert.deepEqual(
    [cost.fgtsCents, cost.vacationProvisionCents, cost.thirteenthProvisionCents, cost.fgtsVacationCents, cost.fgtsThirteenthCents, cost.fgtsTerminationCents],
    [32507, 45149, 33862, 3612, 2709, 15531],
  );
  assert.equal(cost.totalCostCents, 406338 + 32507 + 45149 + 33862 + 3612 + 2709 + 15531);
  const total = sumEmployeeCosts([cost, computeEmployeeCost({ baseSalaryCents: 100000, commissionCents: 0, overtimeCents: 0 })]);
  assert.equal(total.baseSalaryCents, 264800);
  assert.equal(total.fgtsCents, 32507 + 8000);
});

test("DSR saiu (04/11/2026): o digitado fica guardado mas não entra na Folha, na DRE nem no relatório", async () => {
  const put = await callRoute(monthValuesRoute.PUT, RH_ONLY, "PUT", "/api/hr-payroll/month-values", {
    month: "2026-10", kind: "dsr", values: [{ employeeId: "alex", amountCents: 65538 }, { employeeId: "bia", amountCents: 0 }],
  });
  assert.equal(put.status, 200, JSON.stringify(await put.clone().json()));
  const listed = await (await callRoute(monthValuesRoute.GET, RH_ONLY, "GET", "/api/hr-payroll/month-values?month=2026-10&kind=dsr")).json();
  assert.deepEqual(listed.values.map((row) => [row.employeeId, row.amountCents]), [["alex", 65538]]);
  const bad = await callRoute(monthValuesRoute.PUT, RH_ONLY, "PUT", "/api/hr-payroll/month-values", { month: "2026-10", kind: "dsr", values: [{ employeeId: "x", amountCents: 1 }] });
  assert.equal(bad.status, 400);

  const folha = await (await callRoute(entriesRoute.GET, RH_ONLY, "GET", "/api/hr-payroll/entries?month=2026-10")).json();
  const alex = folha.entries.find((row) => row.employeeId === "alex");
  assert.equal(alex.dsrCents, undefined);
  assert.equal(alex.custoTotalCents, 164800 + 176000);

  const dre = await loadPayrollDreContribution(globalThis.__routeTestDb, { companyId: ALFA }, "2026-10");
  // Sem folha lançada a DRE não soma salário (e o DSR não entra mais).
  assert.equal(dre.byItem.get("rh-folha"), undefined);

  assert.equal((await callRoute(costRoute.GET, RH_ONLY, "GET", "/api/hr-payroll/cost-report?month=2026-10")).status, 403);
  const report = await (await callRoute(costRoute.GET, RH_FIN, "GET", "/api/hr-payroll/cost-report?month=2026-10")).json();
  const line = report.rows.find((row) => row.employeeId === "alex");
  assert.deepEqual([line.baseSalaryCents, line.commissionCents, line.dsrCents, line.remunerationCents], [164800, 176000, undefined, 340800]);
  assert.equal(report.rows.length, 2);
  assert.equal(report.total.totalCostCents, report.rows.reduce((sum, row) => sum + row.totalCostCents, 0));
  assert.equal((await callRoute(costRoute.GET, ADMIN, "GET", "/api/hr-payroll/cost-report?month=2026-10")).status, 200);
});

test("tela: Folha de PAGAMENTO (contracheque/premiação/valor total), sem DSR nem comprovante, e o CUSTO TOTAL POR FUNCIONÁRIO", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="rhFolhaVisao"|FOLHA PAGA \(SAI DA CONTA\)/);
  assert.match(html, /<th>Colaborador<\/th><th>Banco<\/th><th>Chave PIX<\/th><th>Loja admissão<\/th><th>Loja atuante<\/th><th>Contracheque<\/th><th>Premiação<\/th><th>Descontos<\/th><th>Valor total<\/th><th>Observações<\/th>/);
  assert.doesNotMatch(html, /btnRhFolhaDsr|btnRhCustoFuncDsr|rhFolhaAttachInput|data-rh-folha-attach/);
  assert.match(html, /id="rhFolhaAdmissao"[\s\S]*id="rhFolhaNome"/);
  assert.match(html, /id="rhFolhaBulkBar"/);
  assert.match(html, /id="btnRhCustoFuncionario"/);
  assert.match(html, /function rhCanSeeCostReport\(\)\{ return canAccess\('payroll'\) && canAccess\('finance'\); \}/);
  for (const label of ["PROVISÃO FÉRIAS + 1/3", "PROVISÃO FGTS RESCISÓRIO", "COLAR DA PLANILHA"]) assert.ok(html.includes(label), label);
});
