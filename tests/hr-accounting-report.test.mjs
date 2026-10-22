import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Relatório COMISSIONAMENTO / HORAS / PREMIAÇÃO para a contabilidade e HORAS
// EXTRAS A PAGAR em três tipos (prompt 11, 22/10/2026).

const lib = await import("../app/lib/hr-accounting-report.ts");
const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_commissions", "hr_commission_items", "hr_payroll_entries", "hr_benefits",
  "hr_payroll_settings", "hr_time_tracking_entries", "hr_time_tracking_settings",
  "commercial_monthly", "commercial_rules", "commercial_newcomers", "commercial_credit_entries", "commercial_store_goals", "commercial_roles",
]);
const payouts = await import("../app/api/hr-time-tracking/payouts/route.ts");
const balance = await import("../app/api/hr-time-tracking/balance/route.ts");
const report = await import("../app/api/hr-payroll/accounting-report/route.ts");
const entries = await import("../app/api/hr-payroll/entries/route.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA", cnpj: "11222333000181" }, { id: BETA, name: "LOJA BETA", cnpj: "99888777000166" }]),
});

const overtime = (he50 = [0, 0], he100 = [0, 0], night = [0, 0]) => ({
  he50: { minutes: he50[0], rateCents: he50[1] },
  he100: { minutes: he100[0], rateCents: he100[1] },
  night: { minutes: night[0], rateCents: night[1] },
});

test("desconto maior que a comissão: comissão 0, sobra vai para o mês seguinte e a premiação fica intacta", () => {
  const chain = lib.commissionCarryChain([
    { month: "2026-10", commissionCents: 10000, discountCents: 15000 },
    { month: "2026-12", commissionCents: 20000, discountCents: 0 },
  ], "2026-12");
  assert.deepEqual(
    [...chain.values()].map((c) => [c.month, c.carryInCents, c.netCommissionCents, c.carryOutCents]),
    [["2026-10", 0, 0, 5000], ["2026-11", 5000, 0, 5000], ["2026-12", 5000, 15000, 0]],
  );
  const { groups, total } = lib.buildAccountingReport([{
    employeeId: "e", employeeName: "ANA", companyId: ALFA, companyName: "LOJA ALFA", cnpj: "1",
    carry: chain.get("2026-10"), discountLabels: ["VALE"], premiumCents: 30000, overtime: lib.computeOvertime({}),
  }]);
  assert.equal(groups[0].rows[0].totalCents, 30000, "premiação não é abatida");
  assert.equal(total.carryOutCents, 5000);
});

test("três tipos de HE: valor da hora = salário ÷ 220 × fator; só HE 50% e 100% abatem o banco", () => {
  assert.deepEqual(["he50", "he100", "night"].map((kind) => lib.suggestedHourlyRateCents(220000, kind)), [1500, 2000, 200]);
  const result = lib.computeOvertime(overtime([150, 1500], [60, 2000], [120, 200]));
  assert.deepEqual([result.he50.amountCents, result.he100.amountCents, result.night.amountCents, result.totalCents], [3750, 2000, 400, 6150]);
  assert.equal(lib.bankPaidMinutes(overtime([150, 0], [60, 0], [120, 0])), 210);
});

test("HORAS PAGAS: lança os três tipos, valor da hora em branco = sugerido, abate só HE do banco", async () => {
  db.insert("hr_employees", { id: "ana", full_name: "ANA", company_id: ALFA, company_name: "LOJA ALFA", salary_cents: 220000, status: "active", cpf: "1", created_by: "x" });
  const response = await callRoute(payouts.POST, ADMIN, "POST", "/api/hr-time-tracking/payouts", {
    employeeId: "ana", yearMonth: "2026-10", he50Minutes: 150, he50RateCents: 0, he100Minutes: 60, he100RateCents: 2500, nightMinutes: 120, nightRateCents: 0,
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const row = db.sqlite.prepare("SELECT * FROM hr_time_tracking_payouts WHERE employee_id='ana'").get();
  assert.deepEqual([row.paid_minutes, row.he50_rate_cents, row.he100_rate_cents, row.night_rate_cents], [210, 1500, 2500, 200]);
  const listed = await (await callRoute(payouts.GET, ADMIN, "GET", "/api/hr-time-tracking/payouts?employeeId=ana")).json();
  assert.deepEqual(listed.suggestedRateCents, { he50: 1500, he100: 2000, night: 200 });
  const noSalary = await (await callRoute(payouts.GET, { id: "p", permissions: ["rh_ponto_logistica:manage"] }, "GET", "/api/hr-time-tracking/payouts?employeeId=ana")).json();
  assert.equal(noSalary.suggestedRateCents, null, "sem RH Financeiro não vê o valor derivado do salário");
  const months = (await (await callRoute(balance.GET, ADMIN, "GET", "/api/hr-time-tracking/balance?employeeId=ana")).json()).months;
  assert.equal(months.find((m) => m.yearMonth === "2026-10").paidMinutes, 210, "adicional noturno não abate o banco");
  // A HE a pagar vira a HE da Folha do mês (fonte única).
  const folha = await (await callRoute(entries.GET, ADMIN, "GET", "/api/hr-payroll/entries?month=2026-10")).json();
  const ana = folha.entries.find((item) => item.employeeId === "ana");
  assert.deepEqual([ana.overtimeCents, ana.overtimeFromTimeTracking], [3750 + 2500 + 400, true]);
});

test("relatório: por CNPJ, comissão bruta/descontos com descrição/líquida, premiação separada e HE; sobra aparece nos dois meses", async () => {
  db.insert("hr_employees", { id: "bia", full_name: "BIA", company_id: BETA, company_name: "LOJA BETA", salary_cents: 100000, status: "active", cpf: "2", created_by: "x" });
  db.insert("hr_commissions", { id: "c-ana-10", month: "2026-10", employee_id: "ana", company_id: ALFA, commission_cents: 50000, commercial_premium_cents: 20000, premiums_cents: 5000, discounts_cents: 0, created_by: "x" });
  db.insert("hr_commissions", { id: "c-bia-09", month: "2026-09", employee_id: "bia", company_id: BETA, commission_cents: 10000, discounts_cents: 25000, created_by: "x" });
  db.insert("hr_commissions", { id: "c-bia-10", month: "2026-10", employee_id: "bia", company_id: BETA, commission_cents: 30000, commercial_premium_cents: 10000, discounts_cents: 2000, created_by: "x" });
  db.insert("hr_commission_items", { id: "i1", commission_id: "c-bia-10", label: "ADIANTAMENTO", kind: "desconto", amount_cents: 2000, created_by: "x" });

  const september = await (await callRoute(report.GET, ADMIN, "GET", "/api/hr-payroll/accounting-report?month=2026-09")).json();
  const biaSep = september.groups.flatMap((g) => g.rows).find((r) => r.employeeId === "bia");
  assert.deepEqual([biaSep.carry.netCommissionCents, biaSep.carry.carryOutCents], [0, 15000]);

  const october = await (await callRoute(report.GET, ADMIN, "GET", "/api/hr-payroll/accounting-report?month=2026-10")).json();
  assert.deepEqual(october.groups.map((g) => g.cnpj), ["11222333000181", "99888777000166"]);
  const ana = october.groups[0].rows[0];
  assert.deepEqual([ana.carry.netCommissionCents, ana.premiumCents, ana.overtime.totalCents], [50000, 25000, 6650]);
  assert.equal(ana.totalCents, 50000 + 25000 + 6650);
  const bia = october.groups[1].rows[0];
  // 300 de comissão − (20 do mês + 150 de sobra de setembro) = 130; premiação 100 intacta.
  assert.deepEqual([bia.carry.carryInCents, bia.carry.netCommissionCents, bia.carry.carryOutCents, bia.premiumCents], [15000, 13000, 0, 10000]);
  assert.deepEqual(bia.discountLabels, ["SOBRA DE DESCONTO DO MÊS ANTERIOR", "ADIANTAMENTO"]);
  assert.equal(october.total.totalCents, ana.totalCents + bia.totalCents);
  assert.equal(october.groups[1].subtotal.totalCents, bia.totalCents);
});

test("tela: página do relatório (RH + atalho no RH Financeiro), PDF/XLSX e diálogo de HORAS PAGAS com os três tipos", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(html, /id="pageRhContabilidade"/);
  assert.match(html, /id="navRhContabilidade"/);
  assert.match(html, /id="navFinanceiroRhContabilidade"/);
  assert.match(html, /rhContabilidade:'\/rh\/relatorio-contabilidade'/);
  assert.match(html, /id="btnRhContabXlsx"/);
  assert.match(html, /id="btnRhContabPdf"/);
  assert.match(html, /data-payout-minutes="'\+kind.key\+'"/);
  assert.match(worker, /"\/rh\/relatorio-contabilidade"/);
});
