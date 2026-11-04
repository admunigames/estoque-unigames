import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Folha de PAGAMENTO (04/11/2026): CONTRACHEQUE digitado/lido do PDF +
// PREMIAÇÃO do Comissionamento − DESCONTOS; pagamento em lote; comissão do
// operacional dividida entre ASSISTÊNCIA e loja na DRE; leitura do PDF.

const db = await setupRouteDb([
  "shared_state", "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings",
  "hr_recurring_deductions", "hr_schedule_assignments", "hr_time_tracking_payouts", "hr_terminations", "commercial_store_goals",
]);
const entriesRoute = await import("../app/api/hr-payroll/entries/route.ts");
const { loadPayrollDreContribution } = await import("../app/api/finance/dre/payroll.ts");

const ALFA = "clojaalfa1", ASSIST = "cassist001";
const RH = { id: "rh", permissions: ["payroll:manage"] };
const M = "2030-10";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: ASSIST, name: "ASSISTÊNCIA" }]) });
db.insert("hr_employees", {
  id: "geo", full_name: "GEOVANA SOARES DA SILVA", company_id: ALFA, company_name: "LOJA ALFA", status: "active", cpf: "1",
  salary_cents: 183200, bank_name: "NUBANK", pix_key: "geo@pix", admission_company_id: ALFA, admission_company_name: "LOJA ALFA",
});
db.insert("hr_employees", { id: "op", full_name: "OPERACIONAL UM", company_id: ALFA, company_name: "LOJA ALFA", status: "active", cpf: "2" });
db.insert("hr_commissions", { id: "c1", month: M, employee_id: "geo", company_id: ALFA, commission_cents: 50000, commercial_premium_cents: 20000, premiums_cents: 5000, created_by: "x" });
// Operacional: 300 de comissão do feito da assistência + 200 premiação da assistência (= 500 da assistência) + 100 premiação pela loja.
db.insert("hr_commissions", { id: "c2", month: M, employee_id: "op", company_id: ALFA, commission_cents: 30000, commercial_premium_cents: 30000, assist_cents: 50000, created_by: "x" });
const post = (body) => callRoute(entriesRoute.POST, RH, "POST", "/api/hr-payroll/entries", body);
const rows = async () => (await (await callRoute(entriesRoute.GET, RH, "GET", `/api/hr-payroll/entries?month=${M}`)).json()).entries;

test("contracheque em lote + premiação − descontos = VALOR TOTAL; banco, PIX e lojas na linha", async () => {
  const res = await post({ action: "payslips", month: M, values: [{ employeeId: "geo", payslipCents: 158152 }] });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const geo = (await rows()).find((row) => row.employeeId === "geo");
  assert.deepEqual([geo.saved, geo.payslipCents, geo.premiumCents, geo.baseSalaryCents], [true, 158152, 25000, 183200]);
  assert.deepEqual([geo.bankName, geo.pixKey, geo.admissionCompanyName, geo.companyName], ["NUBANK", "geo@pix", "LOJA ALFA", "LOJA ALFA"]);
  await post({ id: geo.id, employeeId: "geo", month: M, baseSalaryCents: 183200, deductionsCents: 3000, payslipCents: 158152 });
  assert.equal((await rows()).find((row) => row.employeeId === "geo").totalPayCents, 158152 + 25000 - 3000);
});

test("marcar como pago em lote e desfazer", async () => {
  await post({ action: "payslips", month: M, values: [{ employeeId: "op", payslipCents: 100000 }] });
  const ids = (await rows()).map((row) => row.id);
  assert.equal((await post({ action: "mark_paid", ids, paymentDone: true })).status, 400, "sem data");
  assert.equal((await post({ action: "mark_paid", ids: [...ids, "nao-existe"], paymentDone: true, paymentDate: "2030-11-05" })).status, 404);
  assert.equal((await post({ action: "mark_paid", ids, paymentDone: true, paymentDate: "2030-11-05" })).status, 200);
  assert.ok((await rows()).every((row) => row.paymentDone && row.paymentDate === "2030-11-05"));
  await post({ action: "mark_paid", ids, paymentDone: false });
  assert.ok((await rows()).every((row) => !row.paymentDone));
});

test("DRE: comissão do operacional — parte da assistência na ASSISTÊNCIA, premiação da loja na loja", async () => {
  const comissoes = async (companyId) => (await loadPayrollDreContribution(globalThis.__routeTestDb, { companyId }, M)).byItem.get("rh-comissoes") ?? 0;
  assert.equal(await comissoes(ASSIST), 50000);
  assert.equal(await comissoes(ALFA), 75000 + 10000);
  assert.equal((await loadPayrollDreContribution(globalThis.__routeTestDb, "stores", M)).byItem.get("rh-comissoes"), 135000);
});

test("leitura do PDF do contador (modelo GEOVANA): líquido, INSS, bases e FGTS; CPF não sai", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  const start = html.indexOf("function rhParsePayslipPdf(");
  let depth = 0, end = html.indexOf("{", start);
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    if (html[end] === "}" && --depth === 0) break;
  }
  const parse = new Function(`${html.slice(start, end + 1)}; return rhParsePayslipPdf;`)();
  const lines = [
    "Empr.: 115 GEOVANA SOARES DA SILVA Situação: Trabalhando CPF: 136.733.044-02 Adm: 16/12/2025",
    "Vínculo: Celetista CC: 1 Depto: 1 Horas Mês: 220,00",
    "Cargo: 1 VENDEDOR C.B.O: 521110 Filial: 1 Salário: 1.832,00",
    "8781 DIAS NORMAIS 30,00 1.832,00 P 998 I.N.S.S. 7,67 140,56 D",
    "201 VALE TRANSPORTE 6% 6,00 109,92 D",
    "ND: 0 Proventos: 1.832,00 Descontos: 250,48 Informativa: 146,56 Informativa Dedutora: 0 Líquido: 1.581,52",
    "INF: 0 Base INSS: 1.832,00 Excedente INSS: 0,00 Base FGTS: 1.832,00 Valor FGTS: 146,56 Base IRRF: 1.224,80",
    "Empr.: 116 JOÃO TESTE Situação: Trabalhando",
    "ND: 0 Proventos: 1.000,00 Descontos: 0,00 Líquido: 1.000,00",
  ];
  const [geo, joao] = parse(lines);
  assert.deepEqual(geo, {
    code: "115", name: "GEOVANA SOARES DA SILVA", salaryCents: 183200, netCents: 158152, inssCents: 14056, inssPctBps: 767,
    inssBaseCents: 183200, fgtsBaseCents: 183200, fgtsCents: 14656,
  });
  assert.equal(JSON.stringify(geo).includes("136"), false);
  assert.deepEqual([joao.name, joao.netCents, joao.fgtsCents], ["JOÃO TESTE", 100000, 0]);
});
