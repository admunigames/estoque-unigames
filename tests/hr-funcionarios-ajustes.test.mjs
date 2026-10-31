import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// RH > Funcionários (31/10/2026): férias pela CLT, benefício com VALOR TOTAL
// no cadastro, LOJA ATUANTE em lote, desligamento na LOJA CADASTRADA com
// rescisão e checklist, e FACEPONTO na DRE Funcionário.

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings",
  "hr_terminations", "hr_aso_exams", "hr_vacations", "hr_schedule_assignments", "hr_recruitment_candidates",
  "hr_recruitment_test_payments", "hr_employee_month_values", "hr_time_tracking_payouts", "hr_settings", "app_users",
]);
const { vacationStatus, vacationDays } = await import("../app/lib/hr-vacations.ts");
const { employeeBenefitRule, cycleBenefitAmounts } = await import("../app/lib/hr-benefit-cycle.ts");
const vacationsRoute = await import("../app/api/hr-payroll/vacations/route.ts");
const batchRoute = await import("../app/api/hr-payroll/employees/acting-stores/batch/route.ts");
const terminationsRoute = await import("../app/api/hr-payroll/terminations/route.ts");
const dreRoute = await import("../app/api/hr-payroll/employee-dre/route.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const ADMIN = { id: "admin", role: "admin" };
const SO_FUNC = { id: "func", permissions: ["rh_funcionarios:view"] };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }]) });
db.insert("hr_employees", {
  id: "e1", full_name: "ANA", company_id: BETA, company_name: "LOJA BETA", status: "active", cpf: "1",
  admission_company_id: ALFA, admission_company_name: "LOJA ALFA", admission_date: "2024-03-10", faceponto_cents: 633,
});
db.insert("hr_employees", { id: "e2", full_name: "BRUNO", company_id: ALFA, company_name: "LOJA ALFA", status: "active", cpf: "2", admission_date: "2025-01-01" });

test("férias CLT: período mais antigo com saldo, vencimento 12 meses após o aquisitivo", () => {
  assert.equal(vacationDays("2025-03-10", "2025-03-29"), 20);
  // Admissão 10/03/2024: 1º período 10/03/2024–09/03/2025, vence 09/03/2026.
  let status = vacationStatus("2024-03-10", [], "2025-06-01");
  assert.equal(status.next.start, "2024-03-10");
  assert.equal(status.next.end, "2025-03-09");
  assert.equal(status.next.deadline, "2026-03-09");
  assert.equal(status.next.situation, "a_vencer");
  // Gozou 20 dias: saldo 10 continua no mesmo período; vencido depois do prazo.
  status = vacationStatus("2024-03-10", [{ acquisitionStart: "2024-03-10", startDate: "2025-04-01", endDate: "2025-04-20" }], "2026-04-01");
  assert.equal(status.next.remainingDays, 10);
  assert.equal(status.next.situation, "vencida");
  assert.equal(status.lastReturn, "2025-04-21");
  // 30 dias gozados: passa ao período seguinte; ainda adquirindo = em aquisição.
  status = vacationStatus("2024-03-10", [{ acquisitionStart: "2024-03-10", startDate: "2025-04-01", endDate: "2025-04-30" }], "2025-12-01");
  assert.equal(status.next.start, "2025-03-10");
  assert.equal(status.next.situation, "em_aquisicao");
  assert.equal(vacationStatus("", [], "2025-12-01").next, null);
});

test("benefício: VALOR TOTAL do cadastro substitui a regra; transporte proporcional aos dias", () => {
  const rule = { foodCents: 24500, transportPerDayCents: 900 };
  const regra = employeeBenefitRule(rule, {}, 22);
  assert.deepEqual(cycleBenefitAmounts(regra, 22), { foodCents: 24500, transportCents: 19800, totalCents: 44300 });
  const total = employeeBenefitRule(rule, { benefitFoodTotalCents: 30000, benefitTransportTotalCents: 22000 }, 22);
  assert.deepEqual(cycleBenefitAmounts(total, 22), { foodCents: 30000, transportCents: 22000, totalCents: 52000 });
  assert.equal(cycleBenefitAmounts(total, 11).transportCents, 11000);
  assert.equal(cycleBenefitAmounts(total, 33).transportCents, 33000);
});

test("loja atuante em lote: grava o mês e o cadastro acompanha", async () => {
  assert.equal((await callRoute(batchRoute.POST, SO_FUNC, "POST", "/api/hr-payroll/employees/acting-stores/batch", { month: "2026-10", items: [] })).status, 403);
  assert.equal((await callRoute(batchRoute.POST, ADMIN, "POST", "/api/hr-payroll/employees/acting-stores/batch", { month: "2026-10", items: [{ employeeId: "e2", companyId: "xx" }] })).status, 400);
  const saved = await callRoute(batchRoute.POST, ADMIN, "POST", "/api/hr-payroll/employees/acting-stores/batch", { month: "2026-10", items: [{ employeeId: "e2", companyId: BETA }] });
  assert.deepEqual(await saved.json(), { saved: 1 });
  const stores = (await (await callRoute(batchRoute.GET, ADMIN, "GET", "/api/hr-payroll/employees/acting-stores/batch?month=2026-10")).json()).stores;
  assert.equal(stores.e2.companyId, BETA);
});

test("desligamento: nasce na LOJA CADASTRADA, edição grava checklist e pagamento", async () => {
  const created = await callRoute(terminationsRoute.POST, ADMIN, "POST", "/api/hr-payroll/terminations", {
    employeeId: "e1", terminationDate: "2026-10-15", reason: "pedido_demissao", severanceCents: 150000, fgtsCents: 20000,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  let list = (await (await callRoute(terminationsRoute.GET, ADMIN, "GET", "/api/hr-payroll/terminations")).json()).terminations;
  assert.equal(list[0].companyId, ALFA);
  assert.equal(list[0].finished, false);
  const checklist = Object.fromEntries(Object.keys(list[0].checklist).map((key) => [key, { status: "feito", note: "" }]));
  const edited = await callRoute(terminationsRoute.POST, ADMIN, "POST", "/api/hr-payroll/terminations", {
    id, employeeId: "e1", terminationDate: "2026-10-15", reason: "pedido_demissao", severanceCents: 150000, fgtsCents: 20000,
    severancePaidDate: "2026-10-20", checklist,
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  list = (await (await callRoute(terminationsRoute.GET, ADMIN, "GET", "/api/hr-payroll/terminations")).json()).terminations;
  assert.equal(list[0].severancePaidDate, "2026-10-20");
  assert.equal(list[0].pending, 0);
  assert.equal(list[0].finished, true);
});

test("DRE Funcionário: FACEPONTO só de quem tem valor, na loja atuante do mês", async () => {
  const report = await (await callRoute(dreRoute.GET, ADMIN, "GET", "/api/hr-payroll/employee-dre?month=2026-10")).json();
  assert.deepEqual(report.faceponto.map((row) => [row.personName, row.amountCents]), [["ANA", 633]]);
});

test("férias: cadastra, lista no acompanhamento e só com RH Financeiro", async () => {
  assert.equal((await callRoute(vacationsRoute.GET, SO_FUNC, "GET", "/api/hr-payroll/vacations")).status, 403);
  const bad = await callRoute(vacationsRoute.POST, ADMIN, "POST", "/api/hr-payroll/vacations", { employeeId: "e2", acquisitionStart: "2025-01-01", startDate: "2026-02-10", endDate: "2026-02-01" });
  assert.equal(bad.status, 400);
  const ok = await callRoute(vacationsRoute.POST, ADMIN, "POST", "/api/hr-payroll/vacations", {
    employeeId: "e2", acquisitionStart: "2025-01-01", startDate: "2026-02-01", endDate: "2026-03-02", netCents: 250000, notes: "ok",
  });
  assert.equal(ok.status, 201);
  const data = await (await callRoute(vacationsRoute.GET, ADMIN, "GET", "/api/hr-payroll/vacations")).json();
  assert.equal(data.vacations[0].days, 30);
  assert.equal(data.vacations[0].notes, "OK");
  const bruno = data.summary.find((item) => item.employeeId === "e2");
  assert.equal(bruno.periods[0].remainingDays, 0);
  assert.equal(bruno.lastReturn, "2026-03-03");
});
