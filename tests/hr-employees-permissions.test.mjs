import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// RH > Funcionários com permissões próprias (rh_funcionarios:*). Sem
// payroll:manage, salário/PIX/banco/benefícios não saem nem são alterados.

const db = await setupRouteDb(["shared_state", "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_terminations", "hr_aso_exams", "app_users"]);
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "clojaalfa1", name: "LOJA ALFA" }]) });
const route = await import("../app/api/hr-payroll/employees/route.ts");
const PAYROLL = { id: "rh-fin", permissions: ["payroll:manage"] };
const VIEW = { id: "v", permissions: ["rh_funcionarios:view"] };
const CREATE = { id: "c", permissions: ["rh_funcionarios:view", "rh_funcionarios:create"] };
const EDIT = { id: "e", permissions: ["rh_funcionarios:view", "rh_funcionarios:edit"] };
const DELETE = { id: "d", permissions: ["rh_funcionarios:delete"] };
const post = (u, b) => callRoute(route.POST, u, "POST", "/api/hr-payroll/employees", b);
const list = async (u) => (await (await callRoute(route.GET, u, "GET", "/api/hr-payroll/employees")).json()).employees;
const row = (id) => ({ ...db.sqlite.prepare("SELECT full_name, salary_cents, pix_key FROM hr_employees WHERE id=?").get(id) });

test("funcionários: ver/cadastrar/editar/excluir separados; financeiro só com RH Financeiro", async () => {
  const created = await post(PAYROLL, { fullName: "maria silva", companyId: "clojaalfa1", salaryCents: 250000, pixKey: "maria@pix" });
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  assert.equal((await callRoute(route.GET, { id: "x", permissions: ["stock:view"] }, "GET", "/api/hr-payroll/employees")).status, 403);
  const seen = (await list(VIEW)).find((e) => e.id === id);
  assert.equal(seen.fullName, "MARIA SILVA");
  assert.equal(seen.salaryCents, undefined);
  assert.equal(seen.pixKey, undefined);
  assert.equal(seen.financialHidden, true);
  assert.equal((await list(PAYROLL)).find((e) => e.id === id).salaryCents, 250000);
  assert.equal((await post(VIEW, { fullName: "JOAO" })).status, 403, "só ver não cadastra");
  const byCreate = await post(CREATE, { fullName: "joao", salaryCents: 999999, pixKey: "x" });
  assert.equal(byCreate.status, 201);
  assert.deepEqual(row((await byCreate.json()).id), { full_name: "JOAO", salary_cents: 0, pix_key: "" }, "sem RH Financeiro entra sem salário/PIX");
  assert.equal((await post(CREATE, { id, fullName: "MARIA" })).status, 403, "cadastrar não edita");
  assert.equal((await post(EDIT, { id, fullName: "maria s. silva", salaryCents: 1, pixKey: "" })).status, 200);
  assert.deepEqual(row(id), { full_name: "MARIA S. SILVA", salary_cents: 250000, pix_key: "maria@pix" }, "edição sem RH Financeiro preserva o financeiro");
  const del = (u) => callRoute(route.DELETE, u, "DELETE", `/api/hr-payroll/employees?id=${id}`);
  assert.equal((await del(EDIT)).status, 403);
  assert.equal((await del(DELETE)).status, 200);
});
