import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Carrega as rotas reais de /api/divergences trocando só o getD1() por um
// SQLite em memória (compatível com a API do D1, inclusive batch()).
const hooks = `
const DB_STUB = "export async function getD1() { return globalThis.__divergencesTestDb; }";
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.\\/)+db$/.test(specifier) && context.parentURL && context.parentURL.includes("/app/api/divergences/")) {
    return { url: "data:text/javascript," + encodeURIComponent(DB_STUB), shortCircuit: true };
  }
  if (specifier.startsWith(".") && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith("file:")) {
    try {
      return await next(specifier + ".ts", context);
    } catch {
      // segue para a resolução normal
    }
  }
  return next(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));

const STORE_A = "criomar01";
const STORE_B = "cguarar01";

function createFakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE shared_state (state_key text PRIMARY KEY, value_json text NOT NULL);
    CREATE TABLE divergence_requests (
      id text PRIMARY KEY, company_id text NOT NULL, company_name text DEFAULT '' NOT NULL,
      status text DEFAULT 'aberto' NOT NULL, notes text DEFAULT '' NOT NULL, finalized_at text DEFAULT '' NOT NULL,
      created_by text DEFAULT '' NOT NULL, created_by_name text DEFAULT '' NOT NULL, created_at text NOT NULL,
      updated_by text DEFAULT '' NOT NULL, updated_by_name text DEFAULT '' NOT NULL, updated_at text NOT NULL
    );
    CREATE TABLE divergence_items (
      id text PRIMARY KEY, request_id text NOT NULL, product_code text DEFAULT '' NOT NULL, product_name text NOT NULL,
      position integer DEFAULT 0 NOT NULL, physical_qty integer DEFAULT 0 NOT NULL, system_qty integer DEFAULT 0 NOT NULL, store_notes text DEFAULT '' NOT NULL,
      status text DEFAULT 'nao_visto' NOT NULL, stock_response text DEFAULT '' NOT NULL,
      responded_by text DEFAULT '' NOT NULL, responded_by_name text DEFAULT '' NOT NULL, responded_at text DEFAULT '' NOT NULL,
      store_reply text DEFAULT '' NOT NULL, store_reply_by text DEFAULT '' NOT NULL,
      store_reply_by_name text DEFAULT '' NOT NULL, store_reply_at text DEFAULT '' NOT NULL,
      inventoried_at text DEFAULT '' NOT NULL, inventoried_by text DEFAULT '' NOT NULL,
      inventoried_by_name text DEFAULT '' NOT NULL, created_by text DEFAULT '' NOT NULL,
      created_by_name text DEFAULT '' NOT NULL, created_at text NOT NULL, updated_by text DEFAULT '' NOT NULL,
      updated_by_name text DEFAULT '' NOT NULL, updated_at text NOT NULL
    );
    CREATE TABLE divergence_item_events (
      id text PRIMARY KEY, item_id text NOT NULL, request_id text NOT NULL, kind text NOT NULL,
      from_status text DEFAULT '' NOT NULL, to_status text DEFAULT '' NOT NULL, text text DEFAULT '' NOT NULL,
      actor_id text DEFAULT '' NOT NULL, actor_name text DEFAULT '' NOT NULL, created_at text NOT NULL
    );
  `);
  sqlite
    .prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)")
    .run(JSON.stringify([{ id: STORE_A, name: "RIOMAR" }, { id: STORE_B, name: "GUARARAPES" }]));

  function statement(text) {
    // node:sqlite antigo (Node 22.13 do CI) não liga parâmetros posicionais
    // a placeholders "?1": converte para "?" na ordem de uso.
    const order = [];
    const sql = text.replace(/\?(\d+)/g, (_match, index) => {
      order.push(Number(index) - 1);
      return "?";
    });
    let params = [];
    const prepared = {
      bind(...values) {
        params = order.length ? order.map((index) => values[index]) : values;
        return prepared;
      },
      execute() {
        return sqlite.prepare(sql).run(...params);
      },
      async run() {
        prepared.execute();
        return { success: true };
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
    };
    return prepared;
  }

  return {
    sqlite,
    prepare: statement,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const item of statements) item.execute();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

const db = createFakeD1();
globalThis.__divergencesTestDb = db;

const listRoute = await import("../app/api/divergences/route.ts");
const detailRoute = await import("../app/api/divergences/[id]/route.ts");
const respondRoute = await import("../app/api/divergences/[id]/items/[itemId]/respond/route.ts");
const replyRoute = await import("../app/api/divergences/[id]/items/[itemId]/store-reply/route.ts");
const inventoryRoute = await import("../app/api/divergences/inventory/route.ts");
const doneRoute = await import("../app/api/divergences/inventory/[itemId]/done/route.ts");
const summaryRoute = await import("../app/api/divergences/summary/route.ts");
const dashboardRoute = await import("../app/api/divergences/dashboard/route.ts");
const lib = await import("../app/lib/divergences.ts");

const BASE = "http://127.0.0.1/api/divergences";
const ALL = ["view", "create", "edit", "delete", "respond", "inventory"].map((action) => `divergencias:${action}`);

const STORE_A_USER = { id: "loja-a", companyId: STORE_A, permissions: ["divergencias:view", "divergencias:create", "divergencias:edit", "divergencias:delete"] };
const STORE_B_USER = { id: "loja-b", companyId: STORE_B, permissions: ["divergencias:view", "divergencias:create", "divergencias:edit", "divergencias:delete"] };
const STOCK_USER = { id: "estoque", companyId: "", permissions: ["divergencias:view", "divergencias:respond", "divergencias:inventory"] };

function headersFor(user, extra = {}) {
  return {
    "x-unigames-user-id": user.id,
    "x-unigames-display-name": encodeURIComponent(user.name || user.id.toUpperCase()),
    "x-unigames-role": user.role || "user",
    "x-unigames-company-id": user.companyId || "",
    "x-unigames-sector": user.sector || "",
    "x-unigames-permissions": (user.permissions || []).join(","),
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function call(handler, user, method, url, body, params = {}) {
  const request = new Request(url, {
    method,
    headers: headersFor(user, body === undefined ? {} : { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(request, { params: Promise.resolve(params) });
}

async function createRequest(user, items, extra = {}) {
  const response = await call(listRoute.POST, user, "POST", BASE, { items, ...extra });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json()).id;
}

async function detail(user, id) {
  const response = await call(detailRoute.GET, user, "GET", `${BASE}/${id}`, undefined, { id });
  return { status: response.status, body: await response.json() };
}

// Pausa curta: o histórico é ordenado pelo horário (ms) de cada ação, e
// aqui as ações seguidas podem cair no mesmo milissegundo.
async function respond(user, id, itemId, status, response) {
  await new Promise((resolve) => setTimeout(resolve, 2));
  return call(respondRoute.POST, user, "POST", `${BASE}/${id}/items/${itemId}/respond`, { status, response }, { id, itemId });
}

const THREE_ITEMS = [
  { productCode: "1001", productName: "ADAPTADOR TIPO C", physicalQty: 1, systemQty: 2, storeNotes: "CAIXA ABERTA" },
  { productCode: "1002", productName: "CONTROLE PS5", physicalQty: 5, systemQty: 3 },
  { productName: "CABO HDMI GENÉRICO", physicalQty: 0, systemQty: 1 },
];

test("regras puras: divergência, rótulo e status do pedido", () => {
  assert.equal(lib.divergenceOf(1, 2), -1);
  assert.equal(lib.divergenceLabel(1, 2), "01 A MENOS FISICAMENTE");
  assert.equal(lib.divergenceLabel(5, 3), "02 A MAIS FISICAMENTE");
  assert.equal(lib.divergenceLabel(4, 4), "SEM DIVERGÊNCIA");
  assert.equal(lib.computeRequestStatus(["nao_visto", "nao_visto"]), "aberto");
  assert.equal(lib.computeRequestStatus(["nao_visto", "concluido"]), "verificacao");
  assert.equal(lib.computeRequestStatus(["concluido", "verificacao_loja"]), "verificacao");
  assert.equal(lib.computeRequestStatus(["concluido", "inventario"]), "finalizado");
  // Recife é UTC-3: 02:59Z ainda é o dia anterior.
  assert.equal(lib.recifeDateOf("2026-10-02T02:59:00.000Z"), "2026-10-01");
  assert.equal(lib.recifeDayStartIso("2026-10-02"), "2026-10-02T03:00:00.000Z");
});

test("status do pedido: EM ABERTO → EM VERIFICAÇÃO → FINALIZADO só com tudo CONCLUÍDO/INVENTÁRIO", async () => {
  const id = await createRequest(STORE_A_USER, THREE_ITEMS, { notes: "CONFERÊNCIA DE SEGUNDA" });
  let { body } = await detail(STORE_A_USER, id);
  assert.equal(body.request.status, "aberto");
  assert.equal(body.request.companyName, "RIOMAR");
  assert.equal(body.items.length, 3);
  assert.equal(body.items[2].productCode, "");
  const [first, second, third] = body.items.map((item) => item.id);

  assert.equal((await respond(STOCK_USER, id, first, "em_verificacao", "")).status, 200);
  assert.equal((await detail(STORE_A_USER, id)).body.request.status, "verificacao");

  assert.equal((await respond(STOCK_USER, id, first, "concluido", "ACERTADO NO PDV")).status, 200);
  assert.equal((await respond(STOCK_USER, id, second, "inventario", "CONTAR NO INVENTÁRIO")).status, 200);
  ({ body } = await detail(STORE_A_USER, id));
  assert.equal(body.request.status, "verificacao", "ainda tem item NÃO VISTO");
  assert.equal(body.request.finalizedAt, "");

  assert.equal((await respond(STOCK_USER, id, third, "verificacao_loja", "CONFIRA A PRATELEIRA")).status, 200);
  assert.equal((await detail(STORE_A_USER, id)).body.request.status, "verificacao");
  assert.equal((await respond(STOCK_USER, id, third, "concluido", "OK")).status, 200);
  ({ body } = await detail(STORE_A_USER, id));
  assert.equal(body.request.status, "finalizado");
  assert.ok(body.request.finalizedAt);
  const firstItem = body.items.find((item) => item.id === first);
  assert.equal(firstItem.stockResponse, "ACERTADO NO PDV");
  assert.equal(firstItem.respondedByName, "ESTOQUE");
  assert.deepEqual(firstItem.events.map((event) => `${event.fromStatus}>${event.toStatus}`),
    [">nao_visto", "nao_visto>em_verificacao", "em_verificacao>concluido"]);

  // Resposta obrigatória (menos para EM VERIFICAÇÃO) e status válido.
  assert.equal((await respond(STOCK_USER, id, first, "concluido", "")).status, 400);
  assert.equal((await respond(STOCK_USER, id, first, "nao_visto", "x")).status, 400);
});

test("VERIFICAÇÃO DA LOJA → retorno da loja (com VISUALIZAR, só a loja do pedido) → volta para EM VERIFICAÇÃO", async () => {
  const id = await createRequest(STORE_A_USER, [THREE_ITEMS[0]]);
  const itemId = (await detail(STORE_A_USER, id)).body.items[0].id;
  const url = `${BASE}/${id}/items/${itemId}/store-reply`;

  // Fora de VERIFICAÇÃO DA LOJA não aceita retorno.
  let reply = await call(replyRoute.POST, STORE_A_USER, "POST", url, { reply: "ACHEI" }, { id, itemId });
  assert.equal(reply.status, 409);

  await respond(STOCK_USER, id, itemId, "verificacao_loja", "CONTE DE NOVO");
  // Sem divergencias:view não responde como loja (nem com editar/cadastrar).
  for (const permissions of [["divergencias:create"], ["divergencias:edit"], ["divergencias:delete"]]) {
    reply = await call(replyRoute.POST, { ...STORE_A_USER, permissions }, "POST", url, { reply: "OK LOJA" }, { id, itemId });
    assert.equal(reply.status, 403, `retorno com ${permissions}`);
  }
  // Quem tem acesso geral (sem loja vinculada) não responde pela loja.
  reply = await call(replyRoute.POST, STOCK_USER, "POST", url, { reply: "OK LOJA" }, { id, itemId });
  assert.equal(reply.status, 403);
  assert.equal((await reply.json()).error, "SÓ A LOJA DO PEDIDO RESPONDE A VERIFICAÇÃO DA LOJA.");
  reply = await call(replyRoute.POST, { id: "admin", role: "admin", companyId: "", permissions: [] }, "POST", url, { reply: "OK LOJA" }, { id, itemId });
  assert.equal(reply.status, 403);
  // Loja B não responde item da loja A.
  reply = await call(replyRoute.POST, STORE_B_USER, "POST", url, { reply: "OK LOJA" }, { id, itemId });
  assert.equal(reply.status, 404);

  // Perfil padrão da loja: só CADASTRAR + VISUALIZAR já responde.
  const basicStore = { id: "loja-a-basica", companyId: STORE_A, permissions: ["divergencias:view", "divergencias:create"] };
  await new Promise((resolve) => setTimeout(resolve, 2));
  reply = await call(replyRoute.POST, basicStore, "POST", url, { reply: "ACHEI MAIS UMA NO DEPÓSITO", physicalQty: 2 }, { id, itemId });
  assert.equal(reply.status, 200);
  const { body } = await detail(STORE_A_USER, id);
  const item = body.items[0];
  assert.equal(item.status, "em_verificacao");
  assert.equal(item.storeReply, "ACHEI MAIS UMA NO DEPÓSITO");
  assert.equal(item.physicalQty, 2);
  assert.equal(body.request.status, "verificacao");
  const last = item.events.at(-1);
  assert.equal(last.kind, "store_reply");
  assert.match(last.text, /CORRIGIDO: FÍSICO 1 → 2/);
});

test("edição pela loja de item já respondido volta para NÃO VISTO e registra ALTERADO PELA LOJA", async () => {
  const id = await createRequest(STORE_A_USER, THREE_ITEMS.slice(0, 2));
  let { body } = await detail(STORE_A_USER, id);
  const [a, b] = body.items;
  await respond(STOCK_USER, id, a.id, "concluido", "AJUSTADO");
  await respond(STOCK_USER, id, b.id, "inventario", "INVENTÁRIO");
  assert.equal((await detail(STORE_A_USER, id)).body.request.status, "finalizado");

  await new Promise((resolve) => setTimeout(resolve, 2));
  const edited = await call(detailRoute.PATCH, STORE_A_USER, "PATCH", `${BASE}/${id}`, {
    notes: "REVISADO",
    items: [
      { id: a.id, productCode: a.productCode, productName: a.productName, physicalQty: 3, systemQty: a.systemQty, storeNotes: a.storeNotes },
      { id: b.id, productCode: b.productCode, productName: b.productName, physicalQty: b.physicalQty, systemQty: b.systemQty, storeNotes: "SÓ A OBS" },
      { productName: "MEMORY CARD", physicalQty: 2, systemQty: 2 },
    ],
  }, { id });
  assert.equal(edited.status, 200);
  ({ body } = await detail(STORE_A_USER, id));
  assert.equal(body.request.notes, "REVISADO");
  assert.equal(body.items.length, 3);
  const changed = body.items.find((item) => item.id === a.id);
  assert.equal(changed.status, "nao_visto");
  assert.equal(changed.physicalQty, 3);
  assert.equal(changed.stockResponse, "");
  const editEvent = changed.events.at(-1);
  assert.equal(editEvent.kind, "store_edit");
  assert.equal(editEvent.fromStatus, "concluido");
  assert.equal(editEvent.toStatus, "nao_visto");
  assert.match(editEvent.text, /^ALTERADO PELA LOJA — FÍSICO: 1 → 3/);
  // Só a observação mudou: status e resposta continuam.
  const notesOnly = body.items.find((item) => item.id === b.id);
  assert.equal(notesOnly.status, "inventario");
  assert.equal(notesOnly.storeNotes, "SÓ A OBS");
  assert.equal(body.request.status, "verificacao");

  // Remover item.
  const removed = await call(detailRoute.PATCH, STORE_A_USER, "PATCH", `${BASE}/${id}`, {
    items: [{ id: b.id, productName: b.productName, productCode: b.productCode, physicalQty: b.physicalQty, systemQty: b.systemQty, storeNotes: "SÓ A OBS" }],
  }, { id });
  assert.equal(removed.status, 200);
  ({ body } = await detail(STORE_A_USER, id));
  assert.equal(body.items.length, 1);
  assert.equal(body.request.status, "finalizado");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM divergence_item_events WHERE item_id=?").get(a.id).n, 0);

  // Validação de itens.
  for (const items of [[], [{ productName: "X", physicalQty: 1, systemQty: 1 }], [{ productName: "OK", physicalQty: -1, systemQty: 1 }], [{ productName: "OK", physicalQty: 1.5, systemQty: 1 }]]) {
    const response = await call(detailRoute.PATCH, STORE_A_USER, "PATCH", `${BASE}/${id}`, { items }, { id });
    assert.equal(response.status, 400, JSON.stringify(items));
  }
});

test("escopo: loja A não vê/edita/exclui pedido da loja B; usuário sem loja vê todas", async () => {
  const idA = await createRequest(STORE_A_USER, [THREE_ITEMS[0]]);
  const idB = await createRequest(STORE_B_USER, [THREE_ITEMS[1]], { companyId: STORE_A });
  // Loja vinculada não escolhe outra loja: fica na própria.
  assert.equal((await detail(STORE_B_USER, idB)).body.request.companyId, STORE_B);

  assert.equal((await detail(STORE_A_USER, idB)).status, 404);
  const listA = await (await call(listRoute.GET, STORE_A_USER, "GET", `${BASE}?companyId=${STORE_B}`)).json();
  assert.ok(listA.requests.every((row) => row.companyId === STORE_A));
  assert.ok(listA.requests.some((row) => row.id === idA));
  assert.equal(listA.allStores, false);

  const patch = await call(detailRoute.PATCH, STORE_A_USER, "PATCH", `${BASE}/${idB}`, { items: [{ productName: "XX", physicalQty: 1, systemQty: 1 }] }, { id: idB });
  assert.equal(patch.status, 404);
  const del = await call(detailRoute.DELETE, STORE_A_USER, "DELETE", `${BASE}/${idB}`, undefined, { id: idB });
  assert.equal(del.status, 404);
  const itemB = (await detail(STORE_B_USER, idB)).body.items[0].id;
  const storeWithRespond = { ...STORE_A_USER, permissions: [...STORE_A_USER.permissions, "divergencias:respond"] };
  assert.equal((await respond(storeWithRespond, idB, itemB, "concluido", "OK RESPOSTA")).status, 404);

  const listAll = await (await call(listRoute.GET, STOCK_USER, "GET", BASE)).json();
  assert.equal(listAll.allStores, true);
  assert.ok(listAll.requests.some((row) => row.id === idA) && listAll.requests.some((row) => row.id === idB));
  const onlyB = await (await call(listRoute.GET, STOCK_USER, "GET", `${BASE}?companyId=${STORE_B}`)).json();
  assert.ok(onlyB.requests.length && onlyB.requests.every((row) => row.companyId === STORE_B));
  const rowA = listAll.requests.find((row) => row.id === idA);
  assert.equal(rowA.itemCount, 1);
  assert.equal(rowA.itemsByStatus.nao_visto, 1);

  // Login com loja continua preso à própria loja mesmo no setor
  // Administrativo (sem exceção por setor — app/lib/access-scope.ts).
  const administrative = { ...STORE_A_USER, sector: "administrative" };
  assert.equal((await detail(administrative, idB)).status, 404);
  const adminSectorList = await (await call(listRoute.GET, administrative, "GET", BASE)).json();
  assert.equal(adminSectorList.allStores, false);
  assert.ok(adminSectorList.requests.every((row) => row.companyId === STORE_A));

  // Sem loja e sem a permissão de criar para todas: precisa escolher a loja.
  const noStoreCreator = { id: "adm", companyId: "", permissions: ["divergencias:create"] };
  const missingStore = await call(listRoute.POST, noStoreCreator, "POST", BASE, { items: [THREE_ITEMS[0]] });
  assert.equal(missingStore.status, 400);
  assert.equal((await missingStore.json()).error, "ESCOLHA A LOJA.");
  const chosen = await call(listRoute.POST, noStoreCreator, "POST", BASE, { items: [THREE_ITEMS[0]], companyId: STORE_B });
  assert.equal(chosen.status, 201);
  // Usuário com loja inexistente/sem loja e sem alcance geral: mensagem padrão.
  const orphan = { id: "orfao", companyId: "", permissions: ["divergencias:view"] };
  const orphanList = await call(listRoute.GET, { ...orphan, permissions: [] }, "GET", BASE);
  assert.equal(orphanList.status, 403);
});

test("cada permissão isolada: 403 sem a ação exata", async () => {
  const id = await createRequest(STORE_A_USER, [THREE_ITEMS[0]]);
  const itemId = (await detail(STORE_A_USER, id)).body.items[0].id;
  const only = (permission) => ({ id: `only-${permission}`, companyId: STORE_A, permissions: [permission] });

  // Sem nenhuma chave do módulo: nada.
  const none = { id: "none", companyId: STORE_A, permissions: ["outputs:view"] };
  assert.equal((await call(listRoute.GET, none, "GET", BASE)).status, 403);
  assert.equal((await call(dashboardRoute.GET, none, "GET", `${BASE}/dashboard`)).status, 403);
  assert.equal((await call(summaryRoute.GET, none, "GET", `${BASE}/summary`)).status, 403);

  for (const permission of ALL) {
    const user = only(permission);
    const create = await call(listRoute.POST, user, "POST", BASE, { items: [THREE_ITEMS[0]] });
    assert.equal(create.status, permission === "divergencias:create" ? 201 : 403, `create com ${permission}`);
    const edit = await call(detailRoute.PATCH, user, "PATCH", `${BASE}/${id}`, { items: [{ id: itemId, ...THREE_ITEMS[0] }] }, { id });
    assert.equal(edit.status, permission === "divergencias:edit" ? 200 : 403, `edit com ${permission}`);
    const answer = await respond(user, id, itemId, "em_verificacao", "");
    assert.equal(answer.status, permission === "divergencias:respond" ? 200 : 403, `respond com ${permission}`);
    const inventory = await call(inventoryRoute.GET, user, "GET", `${BASE}/inventory`);
    assert.equal(inventory.status, permission === "divergencias:inventory" ? 200 : 403, `inventory com ${permission}`);
    const done = await call(doneRoute.POST, user, "POST", `${BASE}/inventory/${itemId}/done`, {}, { itemId });
    assert.equal(done.status, permission === "divergencias:inventory" ? 409 : 403, `done com ${permission}`);
  }
  const deleted = await call(detailRoute.DELETE, only("divergencias:edit"), "DELETE", `${BASE}/${id}`, undefined, { id });
  assert.equal(deleted.status, 403);
  const okDelete = await call(detailRoute.DELETE, only("divergencias:delete"), "DELETE", `${BASE}/${id}`, undefined, { id });
  assert.equal(okDelete.status, 200);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM divergence_items WHERE request_id=?").get(id).n, 0);

  // Escrita de outra origem é recusada.
  const crossSite = await listRoute.POST(new Request(BASE, {
    method: "POST",
    headers: headersFor(STORE_A_USER, { "content-type": "application/json", "sec-fetch-site": "cross-site" }),
    body: JSON.stringify({ items: [THREE_ITEMS[0]] }),
  }));
  assert.equal(crossSite.status, 403);
});

test("inventário: só ANOTADO PARA INVENTÁRIO; INVENTARIADO sai da lista e vai para o histórico; excluir o pedido remove a pendência", async () => {
  const idA = await createRequest(STORE_A_USER, THREE_ITEMS);
  const idB = await createRequest(STORE_B_USER, [THREE_ITEMS[0]]);
  const itemsA = (await detail(STORE_A_USER, idA)).body.items;
  const itemB = (await detail(STORE_B_USER, idB)).body.items[0];
  await respond(STOCK_USER, idA, itemsA[0].id, "inventario", "CONTAR");
  await respond(STOCK_USER, idA, itemsA[1].id, "concluido", "OK");
  await respond(STOCK_USER, idB, itemB.id, "inventario", "CONTAR");

  const active = async (user, query = "") =>
    (await (await call(inventoryRoute.GET, user, "GET", `${BASE}/inventory${query}`)).json()).items;
  let rows = await active(STOCK_USER);
  assert.ok(rows.some((row) => row.id === itemsA[0].id && row.companyName === "RIOMAR" && row.physicalQty === 1 && row.systemQty === 2));
  assert.ok(rows.some((row) => row.id === itemB.id));
  assert.ok(!rows.some((row) => row.id === itemsA[1].id), "CONCLUÍDO não entra no inventário");
  rows = await active(STOCK_USER, `?companyId=${STORE_B}`);
  assert.ok(rows.length && rows.every((row) => row.companyId === STORE_B));
  // Loja com permissão de inventário só vê a própria.
  const storeInventory = { id: "inv-a", companyId: STORE_A, permissions: ["divergencias:inventory"] };
  rows = await active(storeInventory, `?companyId=${STORE_B}`);
  assert.ok(rows.length && rows.every((row) => row.companyId === STORE_A));
  assert.equal((await call(doneRoute.POST, storeInventory, "POST", `${BASE}/inventory/${itemB.id}/done`, {}, { itemId: itemB.id })).status, 404);

  const done = await call(doneRoute.POST, STOCK_USER, "POST", `${BASE}/inventory/${itemsA[0].id}/done`, {}, { itemId: itemsA[0].id });
  assert.equal(done.status, 200);
  const again = await call(doneRoute.POST, STOCK_USER, "POST", `${BASE}/inventory/${itemsA[0].id}/done`, {}, { itemId: itemsA[0].id });
  assert.equal(again.status, 409);
  rows = await active(STOCK_USER);
  assert.ok(!rows.some((row) => row.id === itemsA[0].id));
  const history = await active(STOCK_USER, "?view=history");
  const historyRow = history.find((row) => row.id === itemsA[0].id);
  assert.ok(historyRow && historyRow.inventoriedAt && historyRow.inventoriedByName === "ESTOQUE");
  assert.ok((await active(STOCK_USER, `?view=history&companyId=${STORE_B}`)).every((row) => row.companyId === STORE_B));

  // Excluir o pedido remove a pendência de inventário que veio dele.
  const deleted = await call(detailRoute.DELETE, STORE_B_USER, "DELETE", `${BASE}/${idB}`, undefined, { id: idB });
  assert.equal(deleted.status, 200);
  assert.ok(!(await active(STOCK_USER)).some((row) => row.id === itemB.id));
});

test("widget: alerta de NÃO VISTO há mais de 14 dias e pedidos recentes da loja", async () => {
  const id = await createRequest(STORE_A_USER, THREE_ITEMS.slice(0, 2));
  const [oldItem, freshItem] = (await detail(STORE_A_USER, id)).body.items;
  const day = 86_400_000;
  const old = new Date(Date.now() - 20 * day).toISOString();
  const borderline = new Date(Date.now() - 14 * day).toISOString();
  db.sqlite.prepare("UPDATE divergence_items SET created_at=? WHERE id=?").run(old, oldItem.id);
  db.sqlite.prepare("UPDATE divergence_items SET created_at=? WHERE id=?").run(borderline, freshItem.id);
  assert.equal(lib.isOverdueUnseen("nao_visto", old), true);
  assert.equal(lib.isOverdueUnseen("nao_visto", borderline), false, "14 dias exatos ainda não alerta");
  assert.equal(lib.isOverdueUnseen("em_verificacao", old), false);

  const stock = await (await call(summaryRoute.GET, STOCK_USER, "GET", `${BASE}/summary`)).json();
  assert.equal(stock.view, "stock");
  assert.ok(stock.overdue.count >= 1);
  assert.ok(stock.counts.nao_visto >= 2);
  const stockBefore = stock.overdue.count;

  await respond(STOCK_USER, id, oldItem.id, "verificacao_loja", "CONFIRA");
  const store = await (await call(summaryRoute.GET, STORE_A_USER, "GET", `${BASE}/summary`)).json();
  assert.equal(store.view, "store");
  assert.equal(store.allStores, false);
  const recent = store.recent.find((row) => row.id === id);
  assert.equal(recent.awaitingStore, 1);
  assert.equal(recent.answered, false, "ainda há item aguardando o estoque");
  const stockAfter = await (await call(summaryRoute.GET, STOCK_USER, "GET", `${BASE}/summary`)).json();
  assert.equal(stockAfter.overdue.count, stockBefore - 1, "item respondido sai do alerta");
  assert.ok(stockAfter.counts.verificacao_loja >= 1);
  // Loja B não enxerga números da loja A.
  const storeB = await (await call(summaryRoute.GET, STORE_B_USER, "GET", `${BASE}/summary`)).json();
  assert.ok(storeB.recent.every((row) => row.companyName === "GUARARAPES"));

  await respond(STOCK_USER, id, freshItem.id, "concluido", "OK");
  const answered = (await (await call(summaryRoute.GET, STORE_A_USER, "GET", `${BASE}/summary`)).json())
    .recent.find((row) => row.id === id);
  assert.equal(answered.answered, true);
});

test("dashboard: produtos mais divergentes destacam os que aparecem em mais de uma loja", async () => {
  await createRequest(STORE_A_USER, [{ productCode: "9001", productName: "FONE BT", physicalQty: 1, systemQty: 3 }]);
  await createRequest(STORE_B_USER, [{ productCode: "9001", productName: "FONE BT", physicalQty: 4, systemQty: 3 }]);
  const response = await call(dashboardRoute.GET, STOCK_USER, "GET", `${BASE}/dashboard`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const fone = body.topProducts.find((product) => product.productCode === "9001");
  assert.equal(fone.multiStore, true);
  assert.deepEqual(fone.stores.map((store) => [store.companyName, store.divergence]), [["GUARARAPES", 1], ["RIOMAR", -2]]);
  assert.ok(body.byStore.some((store) => store.companyName === "RIOMAR" && store.missing >= 2));
  assert.ok(body.totals.requests >= 2);
  // DASHBOARD só para acesso geral: usuário com loja vinculada recebe 403,
  // inclusive no setor Administrativo (sem exceção por setor).
  const storeView = await call(dashboardRoute.GET, STORE_A_USER, "GET", `${BASE}/dashboard`);
  assert.equal(storeView.status, 403);
  assert.equal((await storeView.json()).error, "O DASHBOARD É SÓ PARA QUEM TEM ACESSO GERAL.");
  assert.equal((await call(dashboardRoute.GET, { ...STORE_A_USER, sector: "administrative" }, "GET", `${BASE}/dashboard`)).status, 403);
  // Período no futuro: nada.
  const future = await (await call(dashboardRoute.GET, STOCK_USER, "GET", `${BASE}/dashboard?from=2099-01-01&to=2099-01-31`)).json();
  assert.equal(future.totals.requests, 0);
});
