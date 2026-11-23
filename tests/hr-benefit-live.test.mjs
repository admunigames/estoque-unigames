import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Benefícios AO VIVO (23/11/2026): a revisão do ciclo fica no servidor —
// sair da página e voltar mantém a passagem; quem já foi gerado é atualizado
// na hora; gerar apaga o rascunho.

// Todas as tabelas: salvar o cadastro também regrava loja atuante/comissão.
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const db = await setupRouteDb([...schema.matchAll(/pgTable\(\s*"([a-z0-9_]+)"/g)].map((match) => match[1]));
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "clojaalfa1", name: "LOJA ALFA" }]) });
for (const [id, name] of [["e1", "ANA"], ["e2", "BRUNO"]]) {
  db.insert("hr_employees", {
    id, full_name: name, company_id: "clojaalfa1", company_name: "LOJA ALFA", status: "active",
    admission_date: "2024-01-01", work_schedule: "5x2", created_by: "x",
  });
}
const cycle = await import("../app/api/hr-payroll/benefit-cycle/route.ts");
const ADMIN = { id: "admin", role: "admin" };
const URL_ = "/api/hr-payroll/benefit-cycle";
const MONTH = "2030-11";
const call = (method, body, url = URL_) => callRoute(cycle[method], ADMIN, method, url, body);
const load = async () => (await call("GET", undefined, `${URL_}?month=${MONTH}`)).json();

test("rascunho da revisão: grava, volta na leitura e vazio apaga", async () => {
  let response = await call("PATCH", { month: MONTH, employeeId: "e1", review: { transportDays: 3, foodAdjustCents: -1000, reason: "falta" } });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  await call("PATCH", { month: MONTH, payment: { paymentMethod: "cartao", paymentDate: "2030-11-20" } });
  let data = await load();
  assert.deepEqual(data.drafts.e1, { transportDays: 3, foodAdjustCents: -1000, transportAdjustCents: 0, reason: "FALTA" });
  assert.deepEqual(data.draftPayment, { paymentMethod: "cartao", paymentDate: "2030-11-20" });
  assert.equal(data.drafts.e2, undefined);

  response = await call("PATCH", { month: MONTH, employeeId: "e2", review: { transportDays: 5 } });
  assert.equal(response.status, 200);
  await call("PATCH", { month: MONTH, employeeId: "e2", review: null });
  data = await load();
  assert.equal(data.drafts.e2, undefined);

  response = await call("PATCH", { month: "2030-13", employeeId: "e1", review: { transportDays: 1 } });
  assert.equal(response.status, 400);
  response = await call("PATCH", { month: MONTH, payment: { paymentMethod: "boleto" } });
  assert.equal(response.status, 400);
});

test("gerar usa a revisão e apaga o rascunho; gerado é atualizado na hora (um funcionário só)", async () => {
  const before = await load();
  const ana = before.rows.find((row) => row.employeeId === "e1");
  let response = await call("POST", {
    month: MONTH, companyId: "", paymentMethod: "cartao", paymentDate: "2030-11-20", employeeIds: ["e1"],
    adjustments: { e1: before.drafts.e1 },
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  let data = await load();
  assert.equal(data.drafts.e1, undefined, "rascunho de quem foi gerado sai");
  const generated = data.rows.find((row) => row.employeeId === "e1").generated;
  assert.equal(generated.transportDays, 3);
  assert.equal(generated.amountCents, ana.ruleFoodCents - 1000 + 3 * ana.transportPerDayCents);

  // Edição ao vivo do já gerado: o mesmo lançamento muda, sem criar outro.
  response = await call("POST", {
    month: MONTH, companyId: "", paymentMethod: "cartao", paymentDate: "", employeeIds: ["e1"],
    adjustments: { e1: { transportDays: 1, foodAdjustCents: 0, reason: "" } },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { created: 0, updated: 1, skipped: 0 });
  const rows = db.sqlite.prepare("SELECT amount_cents, payment_date FROM hr_benefits WHERE employee_id='e1'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_cents, ana.ruleFoodCents + ana.transportPerDayCents);
  assert.equal(rows[0].payment_date, "2030-11-20", "data do pagamento mantida");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM hr_benefits WHERE employee_id='e2'").get().n, 0, "BRUNO não foi gerado");
});

test("tela de Benefícios grava ao vivo (ciclo, regras e lançamento)", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /function rhCicloSaveRow\(employeeId\)/);
  assert.match(html, /method:'PATCH', headers:\{'Content-Type':'application\/json'\}, body:JSON\.stringify\(\{\n\s+month, employeeId, review: empty \? null : review/);
  assert.match(html, /Object\.entries\(data\.drafts \|\| \{\}\)/);
  assert.match(html, /addEventListener\('change', event => \{\n\s+if\(event\.target\.closest\('\[data-rh-regra\]'\)\) saveRhBeneficioRegras\(\);/);
  assert.match(html, /function rhBeneficioAutosave\(\)/);
  assert.match(html, /el\('rhBeneficioDialog'\)\.addEventListener\('close'/);
  // Estado declarado antes de qualquer função que o lê na carga da página.
  assert.ok(html.indexOf("const rhCicloTimers = new Map();") < html.indexOf("function rhCicloSituacaoCell("));
});

test("AJUSTE TRANSPORTE: desconto na passagem depois de gerado, guardado e relido pela tela", async () => {
  const before = await load();
  const ana = before.rows.find((row) => row.employeeId === "e1");
  // RENATO: 3 dias × R$ 9,00 = R$ 27,00 e desconto de R$ 2,00 → R$ 25,00.
  const response = await call("POST", {
    month: MONTH, companyId: "", paymentMethod: "cartao", paymentDate: "", employeeIds: ["e1"],
    adjustments: { e1: { transportDays: 3, foodAdjustCents: 0, transportAdjustCents: -200, reason: "" } },
  });
  assert.equal(response.status, 201);
  const generated = (await load()).rows.find((row) => row.employeeId === "e1").generated;
  assert.equal(generated.transportCents, 3 * ana.transportPerDayCents - 200);
  assert.equal(generated.transportRateCents, ana.transportPerDayCents);
  assert.equal(generated.transportDays, 3);
  assert.equal(generated.amountCents, ana.ruleFoodCents + 3 * ana.transportPerDayCents - 200);
  assert.match(generated.notes, /TRANSPORTE −R\$ 2,00/);

  await call("PATCH", { month: MONTH, employeeId: "e2", review: { transportAdjustCents: 150 } });
  assert.deepEqual((await load()).drafts.e2, { transportDays: null, foodAdjustCents: 0, transportAdjustCents: 150, reason: "" });
  await call("PATCH", { month: MONTH, employeeId: "e2", review: null });
});

test("RECEBE TRANSPORTE? = NÃO: cadastro grava, ciclo não paga passagem nem ajuste", async () => {
  db.insert("hr_employees", {
    id: "e3", full_name: "CARLA", company_id: "clojaalfa1", company_name: "LOJA ALFA", status: "active",
    admission_date: "2024-01-01", work_schedule: "5x2", created_by: "x", benefit_transport_total_cents: 1200,
  });
  const employees = await import("../app/api/hr-payroll/employees/route.ts");
  const saved = await callRoute(employees.POST, ADMIN, "POST", "/api/hr-payroll/employees", {
    id: "e3", fullName: "CARLA", companyId: "clojaalfa1", status: "active", workSchedule: "5x2",
    receivesTransport: false, benefitTransportTotalCents: 1200,
  });
  assert.ok(saved.status < 300, JSON.stringify(await saved.clone().json()));
  const stored = db.sqlite.prepare("SELECT receives_transport, benefit_transport_total_cents FROM hr_employees WHERE id='e3'").get();
  assert.deepEqual({ ...stored }, { receives_transport: 0, benefit_transport_total_cents: 0 });

  const carla = (await load()).rows.find((row) => row.employeeId === "e3");
  assert.equal(carla.receivesTransport, false);
  assert.equal(carla.transportCents, 0);
  assert.equal(carla.totalCents, carla.foodCents);
  const response = await call("POST", {
    month: MONTH, companyId: "", paymentMethod: "pix", paymentDate: "", employeeIds: ["e3"],
    adjustments: { e3: { transportDays: 5, foodAdjustCents: 0, transportAdjustCents: 900, reason: "" } },
  });
  assert.equal(response.status, 201);
  const items = db.sqlite.prepare("SELECT i.type FROM hr_benefit_items i JOIN hr_benefits b ON b.id=i.benefit_id WHERE b.employee_id='e3'").all();
  assert.deepEqual(items.map((item) => item.type), ["alimentacao"], "sem linha de mobilidade");

  // Quem já existia (sem o campo) continua recebendo.
  assert.equal((await load()).rows.find((row) => row.employeeId === "e2").receivesTransport, true);
});

test("migration 0145 só acrescenta a coluna com SIM como padrão; tela tem o campo e a coluna de ajuste", async () => {
  const sql = await readFile(new URL("../drizzle/0145_rh_funcionario_recebe_transporte.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "receives_transport" integer DEFAULT 1 NOT NULL/);
  assert.doesNotMatch(sql, /DROP|UPDATE|DELETE/i);
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="rhEmployeeReceivesTransport"><option value="1">SIM<\/option><option value="0">NÃO<\/option>/);
  assert.match(html, /<th>Ajuste transporte \(R\$ ±\)<\/th>/);
  assert.match(html, /data-rh-ciclo-field="transportAdjust"/);
  // O texto "TRANSPORTE −R$ 2,00" das observações não pode voltar como MOTIVO do ajuste.
  assert.match(html, /!\/\^\(PASSAGEM\|ALIMENTAÇÃO\|TRANSPORTE\) \[0-9\+−-\]\/\.test\(part\)/);
});
