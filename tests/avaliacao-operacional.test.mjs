import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Avaliação Operacional: situações por unidade com peso 1–5; menor total do
// mês (0 inclusive, empate = todas) é LOJA PREMIUM. Loja só vê/age na própria.

const db = await setupRouteDb(["ops_evaluations", "hr_employees", "hr_schedule_assignments"]);
const RIO = "cmrvhi891w5qk7", REC = "cmrvhi891wn6mr";
const emp = (id, full_name, company_id, status = "active") => db.insert("hr_employees", { id, full_name, company_id, company_name: "", status, cpf: id });
emp("e1", "Ana Riomar", RIO);
emp("e2", "Bia Recife", REC);
emp("e3", "Caio Desligado", RIO, "inactive");
emp("e4", "Duda Assist", "assistencia");
emp("e5", "Edu Escritório", "");
emp("e6", "Fábio Trocou", RIO); // atua no RECIFE desde outubro/2026
db.insert("hr_schedule_assignments", { id: "a1", employee_id: "e6", reference_month: "2026-10", company_id: REC, company_name: "RECIFE" });
const route = await import("../app/api/avaliacao-operacional/route.ts");

const ALL = ["view", "create", "edit", "delete"].map((action) => `avaliacao_operacional:${action}`);
const GESTOR = { id: "gestor", name: "ANA GESTORA", permissions: ALL };
const LEITOR = { id: "leitor", name: "LEITOR", permissions: ["avaliacao_operacional:view"] };
const RIOMAR = { id: "riomar", name: "LOJA RIOMAR", companyId: "cmrvhi891w5qk7", permissions: ALL };
const DEPOSITO = { id: "dep", name: "DEPÓSITO", companyId: "cmsgi8t999bnof", permissions: ALL };
const SEM = { id: "sem", name: "SEM ACESSO", permissions: [] };
const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/avaliacao-operacional${query}`, body);
const add = (actor, unit, eventDate, weight, description = "atraso na abertura", responsible = "joão silva") =>
  call(actor, "POST", { unit, eventDate, weight, description, responsible });

test("lança, soma por unidade, PREMIUM no menor total e escopo da loja", async () => {
  assert.equal((await call(SEM, "GET")).status, 403);
  assert.equal((await add(LEITOR, "RIOMAR", "2026-10-02", 3)).status, 403);
  assert.equal((await add(GESTOR, "OUTRA", "2026-10-02", 3)).status, 400);
  assert.equal((await add(GESTOR, "RIOMAR", "2099-01-01", 3)).status, 400);
  assert.equal((await add(GESTOR, "RIOMAR", "2026-10-02", 6)).status, 400);
  assert.equal((await add(GESTOR, "RIOMAR", "2026-10-02", 3, " ")).status, 400);
  assert.equal((await add(GESTOR, "RIOMAR", "2026-10-02", 3, "x", " ")).status, 400); // quem cometeu é obrigatório

  const created = await add(GESTOR, "RIOMAR", "2026-10-02", 3);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await add(GESTOR, "riomar", "2026-10-20", 5)).status, 201);
  assert.equal((await add(GESTOR, "ADMINISTRATIVO", "2026-10-05", 2)).status, 201);
  assert.equal((await add(GESTOR, "RECIFE", "2026-09-30", 4)).status, 201); // outro mês
  // Loja só lança na própria unidade; loja não avaliada (DEPÓSITO) não age.
  assert.equal((await add(RIOMAR, "RECIFE", "2026-10-03", 1)).status, 400);
  assert.equal((await add(RIOMAR, "RIOMAR", "2026-10-03", 1)).status, 201);
  assert.equal((await add(DEPOSITO, "RIOMAR", "2026-10-03", 1)).status, 400);

  let month = await (await call(LEITOR, "GET", undefined, "?month=2026-10")).json();
  assert.equal(month.ranking.length, 10);
  assert.equal(month.items.length, 4);
  assert.equal(month.items[0].description, "ATRASO NA ABERTURA");
  assert.equal(month.items[0].createdByName, "ANA GESTORA");
  assert.equal(month.items[0].responsible, "JOÃO SILVA");
  const riomar = month.ranking.find((row) => row.unit === "RIOMAR");
  assert.deepEqual([riomar.total, riomar.count, riomar.byWeight[5], riomar.premium], [9, 3, 1, false]);
  assert.equal(month.ranking.at(-1).unit, "RIOMAR");
  // Empate no 0: todas as 8 unidades sem situação são PREMIUM.
  assert.equal(month.ranking.filter((row) => row.premium).length, 8);
  assert.equal(month.ranking.find((row) => row.unit === "RECIFE").premium, true);
  assert.deepEqual(month.can, { view: true, create: false, edit: false, delete: false });

  // Sugestões de QUEM COMETEU: ativos pela loja em que atuam no mês; COMERCIAL/ADMINISTRATIVO = todos.
  const emps = (await (await call(GESTOR, "GET", undefined, "?month=2026-10")).json()).employees;
  assert.deepEqual(emps.RIOMAR, ["ANA RIOMAR"]);
  assert.deepEqual(emps.RECIFE, ["BIA RECIFE", "FÁBIO TROCOU"]);
  assert.deepEqual(emps["ASSISTÊNCIA"], ["DUDA ASSIST"]);
  assert.equal(emps.ADMINISTRATIVO.length, 5);
  assert.deepEqual((await (await call(GESTOR, "GET", undefined, "?month=2026-09")).json()).employees.RIOMAR, ["ANA RIOMAR", "FÁBIO TROCOU"]);
  assert.deepEqual(month.employees, {}); // quem só vê não recebe a lista

  const store = await (await call(RIOMAR, "GET", undefined, "?month=2026-10")).json();
  assert.deepEqual(Object.keys(store.employees), ["RIOMAR"]);
  assert.deepEqual(store.units, ["RIOMAR"]);
  assert.equal(store.ranking.length, 1);
  assert.ok(store.items.every((row) => row.unit === "RIOMAR"));
  const deposito = await (await call(DEPOSITO, "GET", undefined, "?month=2026-10")).json();
  assert.deepEqual([deposito.ranking.length, deposito.items.length, deposito.can.create], [0, 0, false]);

  // Edição registra quem editou; loja não edita/exclui de outra unidade (404).
  const admin = month.items.find((row) => row.unit === "ADMINISTRATIVO");
  assert.equal((await call(RIOMAR, "PATCH", { id: admin.id, unit: "RIOMAR", eventDate: "2026-10-05", weight: 1, description: "x", responsible: "y" })).status, 404);
  assert.equal((await call(RIOMAR, "DELETE", { id: admin.id })).status, 404);
  assert.equal((await call(GESTOR, "PATCH", { id, unit: "RIOMAR", eventDate: "2026-10-02", weight: 1, description: "corrigido", responsible: "maria" })).status, 200);
  assert.equal((await call(GESTOR, "DELETE", { id: admin.id })).status, 200);

  month = await (await call(GESTOR, "GET", undefined, "?month=2026-10")).json();
  const edited = month.items.find((row) => row.id === id);
  assert.deepEqual([edited.weight, edited.description, edited.responsible, edited.updatedByName], [1, "CORRIGIDO", "MARIA", "ANA GESTORA"]);
  assert.equal(month.ranking.find((row) => row.unit === "RIOMAR").total, 7);
  assert.equal(month.ranking.filter((row) => row.premium).length, 9);
  assert.equal(month.items.length, 3);
});
