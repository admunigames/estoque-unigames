import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// RH Financeiro > Benefícios > Lançamentos (17/11/2026): status PAGO / A PAGAR
// em lote (migration 0141), filtro de data de pagamento DE/ATÉ, filtros de
// LOJA ATUANTE (mês da competência) e LOJA DE ADMISSÃO. Login com loja não acessa.

const db = await setupRouteDb(["shared_state", "hr_employees", "hr_schedule_assignments", "hr_benefits", "hr_benefit_items"]);
const route = await import("../app/api/hr-payroll/benefits/route.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const RH = { id: "rh", name: "ana rh", permissions: ["payroll:manage"] };
const LOJA = { id: "loja", name: "LOJA", companyId: ALFA, permissions: ["payroll:manage"] };
const call = (actor, method, path, body) => callRoute(route[method], actor, method, path, body);
const list = async (query = "") => (await (await call(RH, "GET", `/api/hr-payroll/benefits?${query}`)).json()).benefits;
const names = (rows) => rows.map((row) => row.employeeName).sort();

db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }]) });
// ANA: admitida na ALFA, atua na BETA a partir de 2030-11 (Escalas).
db.insert("hr_employees", { id: "e1", full_name: "ANA", company_id: BETA, company_name: "LOJA BETA", admission_company_id: ALFA, admission_company_name: "LOJA ALFA", status: "active", cpf: "1" });
db.insert("hr_schedule_assignments", { id: "s1", employee_id: "e1", employee_name: "ANA", company_id: ALFA, company_name: "LOJA ALFA", reference_month: "2030-10" });
db.insert("hr_schedule_assignments", { id: "s2", employee_id: "e1", employee_name: "ANA", company_id: BETA, company_name: "LOJA BETA", reference_month: "2030-11" });
// BRUNO: sem admissão cadastrada → admissão = loja do cadastro (BETA).
db.insert("hr_employees", { id: "e2", full_name: "BRUNO", company_id: BETA, company_name: "LOJA BETA", status: "active", cpf: "2" });

const benefit = (id, employeeId, name, month, paymentDate, companyId) => {
  db.insert("hr_benefits", {
    id, employee_id: employeeId, employee_name: name, company_id: companyId, company_name: "", month, type: "multiplo",
    payment_method: "pix", amount_cents: 9000, gross_cents: 10000, discount_cents: 1000, payment_date: paymentDate, created_by: "x",
  });
  db.insert("hr_benefit_items", { id: `${id}-a`, benefit_id: id, type: "alimentacao", amount_cents: 7000, discount_cents: 1000 });
  db.insert("hr_benefit_items", { id: `${id}-m`, benefit_id: id, type: "mobilidade", amount_cents: 3000, discount_cents: 0 });
};
benefit("b1", "e1", "ANA", "2030-10", "2030-10-05", ALFA);
benefit("b2", "e1", "ANA", "2030-11", "2030-11-05", ALFA); // gravado antes da troca de loja
benefit("b3", "e2", "BRUNO", "2030-11", "", BETA);

test("login com loja não acessa, mesmo com payroll:manage", async () => {
  assert.equal((await call(LOJA, "GET", "/api/hr-payroll/benefits")).status, 403);
  assert.equal((await call(LOJA, "PATCH", "/api/hr-payroll/benefits", { ids: ["b1"], paid: true })).status, 403);
});

test("loja atuante do mês da competência e loja de admissão (sem cadastro = loja do cadastro)", async () => {
  const by = Object.fromEntries((await list()).map((row) => [row.id, row]));
  assert.equal(by.b1.actingCompanyName, "LOJA ALFA");
  assert.equal(by.b2.actingCompanyName, "LOJA BETA", "calculada na hora, não a gravada");
  assert.equal(by.b2.admissionCompanyName, "LOJA ALFA");
  assert.equal(by.b3.admissionCompanyId, BETA);
  assert.deepEqual(by.b1.items.map((item) => item.type).sort(), ["alimentacao", "mobilidade"]);
  assert.equal(by.b1.paidAt, "", "antigos nascem A PAGAR");

  assert.deepEqual((await list(`actingCompanyId=${BETA}`)).map((row) => row.id).sort(), ["b2", "b3"]);
  assert.deepEqual((await list(`admissionCompanyId=${ALFA}`)).map((row) => row.id).sort(), ["b1", "b2"]);
  assert.deepEqual((await list(`actingCompanyId=${BETA}&admissionCompanyId=${ALFA}`)).map((row) => row.id), ["b2"]);
});

test("filtro DE/ATÉ pela data de pagamento, com ou sem competência", async () => {
  assert.deepEqual(names(await list("paymentFrom=2030-11-01")), ["ANA"]);
  assert.deepEqual((await list("paymentTo=2030-10-31")).map((row) => row.id), ["b1"], "sem data fica de fora");
  assert.deepEqual((await list("month=2030-11&paymentFrom=2030-10-01&paymentTo=2030-12-31")).map((row) => row.id), ["b2"]);
  assert.equal((await call(RH, "GET", "/api/hr-payroll/benefits?paymentFrom=05/11/2030")).status, 400);
});

test("marcar como pago em lote, guarda quem/quando, desmarca e filtra por status", async () => {
  assert.equal((await call(RH, "PATCH", "/api/hr-payroll/benefits", { ids: [], paid: true })).status, 400);
  assert.equal((await call(RH, "PATCH", "/api/hr-payroll/benefits", { ids: ["b1"] })).status, 400);
  assert.equal((await call(RH, "PATCH", "/api/hr-payroll/benefits", { ids: ["b1", "b2"], paid: true })).status, 200);
  let by = Object.fromEntries((await list()).map((row) => [row.id, row]));
  assert.match(by.b1.paidAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(by.b1.paidByName, "ANA RH");
  assert.equal(by.b3.paidAt, "");

  // Marcar de novo não troca quem pagou primeiro.
  const first = by.b1.paidAt;
  await call({ ...RH, id: "outro", name: "outro" }, "PATCH", "/api/hr-payroll/benefits", { ids: ["b1"], paid: true });
  by = Object.fromEntries((await list()).map((row) => [row.id, row]));
  assert.equal(by.b1.paidAt, first);
  assert.equal(by.b1.paidByName, "ANA RH");

  assert.deepEqual((await list("status=pago")).map((row) => row.id).sort(), ["b1", "b2"]);
  assert.deepEqual((await list("status=a_pagar")).map((row) => row.id), ["b3"]);
  assert.equal((await call(RH, "GET", "/api/hr-payroll/benefits?status=x")).status, 400);

  assert.equal((await call(RH, "PATCH", "/api/hr-payroll/benefits", { ids: ["b2"], paid: false })).status, 200);
  by = Object.fromEntries((await list()).map((row) => [row.id, row]));
  assert.equal(by.b2.paidAt, "");
  assert.equal(by.b2.paidByName, "");
});

test("migration 0141 só acrescenta colunas (antigos nascem A PAGAR)", async () => {
  const sql = await readFile(new URL("../drizzle/0141_hr_benefits_pago.sql", import.meta.url), "utf8");
  const statements = sql.split("\n").filter((line) => line && !line.startsWith("--"));
  assert.equal(statements.length, 3);
  for (const line of statements) assert.match(line, /^ALTER TABLE "hr_benefits" ADD COLUMN IF NOT EXISTS "paid_(at|by|by_name)" text DEFAULT '' NOT NULL;/);
});

test("tela: colunas por tipo, lojas, filtros novos, lote, Excel e PDF paisagem", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  for (const id of ["rhBeneficioFiltroAdmissao", "rhBeneficioFiltroDe", "rhBeneficioFiltroAte", "rhBeneficioFiltroStatus",
    "rhBeneficiosBulkBar", "rhBeneficiosEmpresa", "btnRhBeneficiosExcel", "rhBeneficiosPrintBody"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<label for="rhBeneficioFiltroLoja">LOJA ATUANTE<\/label>/);
  assert.match(html, /<th>Loja atuante<\/th><th>Loja admissão<\/th><th>Competência<\/th><th>Alimentação<\/th><th>Transporte<\/th><th>Outros<\/th>/);
  assert.match(html, /@page benefreport\{size:A4 landscape;/);
  assert.match(html, /body\.rh-benef-printing #rhBeneficiosPrintBody\{display:block !important;[^}]*page:benefreport;\}/);
  assert.match(html, /params\.set\(key, el\(id\)\.value\)/);
  assert.match(html, /\['actingCompanyId','rhBeneficioFiltroLoja'\],\['admissionCompanyId','rhBeneficioFiltroAdmissao'\]/);
  assert.match(html, /method:'PATCH'[^\n]*JSON\.stringify\(\{ids, paid\}\)/);
  assert.doesNotMatch(html, /rhBeneficiosPrintPorLoja/, "bloco antigo do PDF saiu");
});
