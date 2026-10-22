import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Cadastros > INFORMAÇÕES GERAIS (prompt 12, 22/10/2026): internet,
// prestadores e outros por loja; permissões info_gerais:view/create/edit/
// delete; login com loja só vê a própria loja.

const db = await setupRouteDb(["shared_state", "info_gerais_items"]);
const route = await import("../app/api/info-gerais/route.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }]) });

const MANAGER = { id: "m", permissions: ["info_gerais:view", "info_gerais:create", "info_gerais:edit", "info_gerais:delete"] };
const VIEWER = { id: "v", permissions: ["info_gerais:view"] };
const STORE = { id: "s", companyId: ALFA, permissions: ["info_gerais:view", "info_gerais:create", "info_gerais:edit"] };
const NONE = { id: "n", permissions: ["stock:view"] };

const post = (actor, body) => callRoute(route.POST, actor, "POST", "/api/info-gerais", body);
const list = async (actor) => (await callRoute(route.GET, actor, "GET", "/api/info-gerais")).json();

test("cadastra internet, prestador e outros; campos por tipo e CAIXA ALTA no texto livre", async () => {
  const internet = await post(MANAGER, { companyId: ALFA, kind: "internet", title: "claro", service: "500 mega", contract: "abc-123", phone: "0800 721 1021", notes: "suporte 24h" });
  assert.equal(internet.status, 201, JSON.stringify(await internet.clone().json()));
  assert.equal((await post(MANAGER, { companyId: ALFA, kind: "prestador", title: "joão eletricista", service: "elétrica", phone: "81 99999-0000", contract: "ignorado" })).status, 201);
  assert.equal((await post(MANAGER, { companyId: BETA, kind: "outros", notes: "chave reserva com o síndico" })).status, 201);
  assert.equal((await post(MANAGER, { companyId: ALFA, kind: "internet", service: "sem provedor" })).status, 400);
  assert.equal((await post(MANAGER, { companyId: ALFA, kind: "senha", title: "x" })).status, 400);

  const data = await list(MANAGER);
  assert.equal(data.items.length, 3);
  const net = data.items.find((item) => item.kind === "internet");
  assert.deepEqual([net.title, net.service, net.contract, net.phone, net.companyName], ["CLARO", "500 MEGA", "abc-123", "0800 721 1021", "LOJA ALFA"]);
  assert.equal(data.items.find((item) => item.kind === "prestador").contract, "", "contrato só existe na internet");
  assert.deepEqual(data.can, { create: true, edit: true, delete: true });
});

test("login com loja só vê e mexe na própria loja; sem permissão é bloqueado", async () => {
  const data = await list(STORE);
  assert.ok(data.items.every((item) => item.companyId === ALFA));
  assert.deepEqual(data.companies.map((company) => company.id), [ALFA]);
  assert.equal(data.allStores, false);
  assert.equal((await post(STORE, { companyId: BETA, kind: "outros", notes: "x" })).status, 403);
  const betaItem = (await list(MANAGER)).items.find((item) => item.companyId === BETA);
  assert.equal((await callRoute(route.PATCH, STORE, "PATCH", `/api/info-gerais?id=${betaItem.id}`, { notes: "invadir" })).status, 404);
  assert.equal((await callRoute(route.GET, NONE, "GET", "/api/info-gerais")).status, 403);
  assert.equal((await post(VIEWER, { companyId: ALFA, kind: "outros", notes: "x" })).status, 403);
  assert.equal((await callRoute(route.DELETE, STORE, "DELETE", `/api/info-gerais?id=${betaItem.id}`)).status, 403, "sem info_gerais:delete");
});

test("edita, reordena e exclui", async () => {
  await post(MANAGER, { companyId: ALFA, kind: "prestador", title: "maria limpeza", service: "limpeza", phone: "81 98888-0000" });
  let items = (await list(MANAGER)).items.filter((item) => item.companyId === ALFA && item.kind === "prestador");
  assert.deepEqual(items.map((item) => item.title), ["JOÃO ELETRICISTA", "MARIA LIMPEZA"]);
  assert.equal((await callRoute(route.PATCH, MANAGER, "PATCH", `/api/info-gerais?id=${items[1].id}`, { move: "up" })).status, 200);
  items = (await list(MANAGER)).items.filter((item) => item.companyId === ALFA && item.kind === "prestador");
  assert.deepEqual(items.map((item) => item.title), ["MARIA LIMPEZA", "JOÃO ELETRICISTA"]);
  const edited = await callRoute(route.PATCH, MANAGER, "PATCH", `/api/info-gerais?id=${items[0].id}`, { title: "maria", service: "faxina", phone: "81 97777-0000" });
  assert.equal(edited.status, 200);
  assert.equal((await list(MANAGER)).items.find((item) => item.id === items[0].id).service, "FAXINA");
  assert.equal((await callRoute(route.DELETE, MANAGER, "DELETE", `/api/info-gerais?id=${items[0].id}`)).status, 200);
  assert.equal((await list(MANAGER)).items.some((item) => item.id === items[0].id), false);
});

test("permissões registradas no worker e em Usuários; página em Cadastros sem campo de senha", async () => {
  const [html, worker] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);
  for (const action of ["view", "create", "edit", "delete"]) {
    assert.ok(worker.includes(`"info_gerais:${action}"`), action);
    assert.ok(html.includes(`value="info_gerais:${action}"`), action);
  }
  assert.match(worker, /path === "\/cadastros\/informacoes-gerais" \|\| path.startsWith\("\/api\/info-gerais"\), "infoGerais"/);
  assert.match(worker, /"\/cadastros\/informacoes-gerais",/);
  assert.match(html, /id="navInfoGerais" data-page="infoGerais" data-permission="info_gerais"/);
  assert.match(html, /infoGerais:'\/cadastros\/informacoes-gerais'/);
  assert.match(html, /data-info-copy=/);
  const page = html.slice(html.indexOf('id="pageInfoGerais"'), html.indexOf('id="pageAuditoria"'));
  const dialog = html.slice(html.indexOf('id="infoGeralDialog"'), html.indexOf('id="rhMonthValuesDialog"'));
  assert.doesNotMatch(page + dialog, /type="password"|SENHA DO WI|senha do roteador/i);
});
