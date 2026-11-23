import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Benefícios AO VIVO (23/11/2026): a revisão do ciclo fica no servidor —
// sair da página e voltar mantém a passagem; quem já foi gerado é atualizado
// na hora; gerar apaga o rascunho.

const db = await setupRouteDb(["shared_state", "hr_employees", "hr_benefits", "hr_benefit_items", "hr_settings", "hr_payroll_settings"]);
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
  assert.deepEqual(data.drafts.e1, { transportDays: 3, foodAdjustCents: -1000, reason: "FALTA" });
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
