import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Auditoria Operacional: permissões, escopo de loja (só finalizadas da própria
// loja, só leitura), finalizar exige tudo respondido, resumo só com NÃO FEITOS
// e itens editados não mudam auditorias já feitas.

const db = await setupRouteDb(["shared_state", "ops_audit_items", "ops_audits", "ops_audit_answers"]);
const route = await import("../app/api/auditoria-operacional/route.ts");
const { AOP_DEFAULT_ITEMS } = await import("../app/lib/auditoria-operacional.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: A, name: "LOJA ALFA" }, { id: B, name: "LOJA BETA" }, { id: "cassist001", name: "ASSISTÊNCIA" }]),
});
const AUDITORA = { id: "aud", name: "AUDITORA", permissions: ["auditoria_operacional:view", "auditoria_operacional:audit"] };
const GESTOR = { id: "ges", permissions: ["auditoria_operacional:view", "auditoria_operacional:manage"] };
const LOJA_A = { id: "loja-a", companyId: A, permissions: ["auditoria_operacional:view", "auditoria_operacional:audit", "auditoria_operacional:manage", "auditoria_operacional:delete"] };
const LOJA_B = { id: "loja-b", companyId: B, permissions: ["auditoria_operacional:view"] };
const SEM = { id: "sem", permissions: [] };
const ADMIN = { id: "adm", role: "admin", permissions: [] };
const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/auditoria-operacional${query}`, body);
const json = async (response) => ({ status: response.status, ...(await response.json()) });

test("32 itens do PDF, 3 seções", () => {
  assert.equal(AOP_DEFAULT_ITEMS.length, 32);
  assert.deepEqual([...new Set(AOP_DEFAULT_ITEMS.map((item) => item.section))], ["ORGANIZACIONAL", "ADMINISTRATIVO", "TÉCNICO"]);
});

test("fluxo completo: criar, marcar, finalizar, resumo, escopo de loja e itens", async () => {
  assert.equal((await call(SEM, "GET")).status, 403);
  // Lojas que vendem (sem Assistência); loja não cria; só quem tem audit.
  const list0 = await json(await call(AUDITORA, "GET"));
  assert.deepEqual(list0.companies.map((company) => company.name), ["LOJA ALFA", "LOJA BETA"]);
  assert.equal((await call(AUDITORA, "POST", { companyId: "cassist001" })).status, 400);
  assert.equal((await call(GESTOR, "POST", { companyId: A })).status, 403);
  assert.equal((await call(LOJA_A, "POST", { companyId: A })).status, 403);

  const created = await json(await call(AUDITORA, "POST", { companyId: A }));
  assert.equal(created.status, 201);
  // Toque duplo na mesma loja/dia: devolve o mesmo rascunho.
  assert.equal((await json(await call(AUDITORA, "POST", { companyId: A }))).id, created.id);

  const detail = await json(await call(AUDITORA, "GET", undefined, `?id=${created.id}`));
  assert.equal(detail.answers.length, 32);
  assert.equal(detail.audit.companyName, "LOJA ALFA");
  assert.equal(detail.audit.auditorName, "AUDITORA");
  assert.equal(detail.audit.status, "draft");

  // Rascunho não aparece para a loja, nem por id.
  assert.equal((await json(await call(LOJA_A, "GET"))).audits.length, 0);
  assert.equal((await call(LOJA_A, "GET", undefined, `?id=${created.id}`)).status, 404);

  // Marca tudo menos o último; 3 NÃO FEITOS com observação.
  const [first, second, ...rest] = detail.answers;
  const last = rest.pop();
  const naoFeitos = new Set([first.id, rest[10].id, rest[25].id]);
  for (const answer of [first, second, ...rest]) {
    const status = naoFeitos.has(answer.id) ? "nao_feito" : "feito";
    const saved = await call(AUDITORA, "PUT", { id: created.id, answerId: answer.id, status, notes: status === "nao_feito" ? `ARRUMAR ${answer.text}` : "" });
    assert.equal(saved.status, 200);
  }
  assert.equal((await call(AUDITORA, "PUT", { id: created.id, answerId: last.id, status: "talvez" })).status, 400);
  assert.equal((await call(LOJA_A, "PUT", { id: created.id, answerId: last.id, status: "feito" })).status, 403);

  // Finalizar exige todos respondidos.
  const early = await json(await call(AUDITORA, "PATCH", { id: created.id, action: "FINALIZAR" }));
  assert.equal(early.status, 409);
  assert.match(early.error, /FALTAM 1/);
  assert.equal((await call(AUDITORA, "PUT", { id: created.id, answerId: last.id, status: "feito" })).status, 200);
  assert.equal((await call(GESTOR, "PATCH", { id: created.id, action: "FINALIZAR" })).status, 403);
  assert.equal((await call(AUDITORA, "PATCH", { id: created.id, action: "FINALIZAR" })).status, 200);
  assert.equal((await call(AUDITORA, "PATCH", { id: created.id, action: "FINALIZAR" })).status, 409);
  // Finalizada = só leitura.
  assert.equal((await call(AUDITORA, "PUT", { id: created.id, answerId: last.id, status: "nao_feito" })).status, 409);

  const final = await json(await call(AUDITORA, "GET", undefined, `?id=${created.id}`));
  assert.equal(final.audit.status, "final");
  assert.equal(final.audit.finalizedByName, "AUDITORA");
  assert.equal(final.summary.done, 29);
  assert.equal(final.summary.pct, 91);
  const improvements = final.summary.sections.flatMap((section) => section.improvements);
  assert.equal(improvements.length, 3);
  assert.ok(improvements.every((item) => item.note.startsWith("ARRUMAR ")));
  assert.ok(!improvements.some((item) => item.text === second.text));

  // Loja A vê a finalizada da própria loja; loja B não vê nada.
  const lojaA = await json(await call(LOJA_A, "GET"));
  assert.equal(lojaA.audits.length, 1);
  assert.equal(lojaA.audits[0].pct, 91);
  assert.deepEqual(lojaA.companies.map((company) => company.id), [A]);
  assert.equal((await call(LOJA_A, "GET", undefined, `?id=${created.id}`)).status, 200);
  assert.equal((await json(await call(LOJA_B, "GET"))).audits.length, 0);
  assert.equal((await call(LOJA_B, "GET", undefined, `?id=${created.id}`)).status, 404);
  assert.equal((await call(LOJA_A, "DELETE", { id: created.id })).status, 403);

  // Itens: só gestor; editar não muda a auditoria feita; desativado não entra na próxima.
  assert.equal((await call(AUDITORA, "GET", undefined, "?items=1")).status, 403);
  const { items } = await json(await call(GESTOR, "GET", undefined, "?items=1"));
  assert.equal(items.length, 32);
  assert.equal((await call(GESTOR, "PATCH", { kind: "item", id: items[0].id, section: "ORGANIZACIONAL", groupName: "ORGANIZAÇÃO", text: "TEXTO NOVO", active: true })).status, 200);
  assert.equal((await call(GESTOR, "PATCH", { kind: "item", id: items[1].id, section: items[1].section, groupName: items[1].groupName, text: items[1].text, active: false })).status, 200);
  assert.equal((await call(GESTOR, "POST", { kind: "item", section: "TÉCNICO", text: "Bancada limpa." })).status, 201);
  assert.equal((await call(GESTOR, "POST", { kind: "item", section: "OUTRA", text: "x" })).status, 400);
  const reordered = [items[2].id, items[0].id];
  assert.equal((await call(GESTOR, "PATCH", { kind: "item-order", ids: reordered })).status, 200);
  const old = await json(await call(AUDITORA, "GET", undefined, `?id=${created.id}`));
  assert.equal(old.answers[0].text, first.text);

  const next = await json(await call(AUDITORA, "POST", { companyId: B }));
  const nextDetail = await json(await call(AUDITORA, "GET", undefined, `?id=${next.id}`));
  assert.equal(nextDetail.answers.length, 32);
  assert.equal(nextDetail.answers[0].text, items[2].text);
  assert.equal(nextDetail.answers[1].text, "TEXTO NOVO");
  assert.ok(!nextDetail.answers.some((answer) => answer.text === items[1].text));
  assert.equal(nextDetail.answers.at(-1).text, "BANCADA LIMPA.");

  // Excluir só com delete (admin).
  assert.equal((await call(AUDITORA, "DELETE", { id: next.id })).status, 403);
  assert.equal((await call(ADMIN, "DELETE", { id: next.id })).status, 200);
  assert.equal((await json(await call(ADMIN, "GET"))).audits.length, 1);
});
