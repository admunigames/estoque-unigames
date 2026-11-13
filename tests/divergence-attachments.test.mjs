import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Divergências: anexos (imagem/PDF) na resposta do ADM e no retorno da loja.
// Loja só anexa no item da própria loja; cada um exclui o que enviou e o ADM
// exclui qualquer um; excluir apaga a chave no R2.

const db = await setupRouteDb(["divergence_requests", "divergence_items", "divergence_item_events", "divergence_item_attachments"]);
// R2 em memória (o do helper só registra exclusões).
const objects = new Map();
const deletedKeys = [];
globalThis.__routeTestBucket = {
  deletedKeys,
  async put(key, value) {
    objects.set(key, value instanceof Uint8Array || value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(String(value)));
  },
  async get(key) {
    const bytes = objects.get(key);
    return bytes ? { size: bytes.byteLength, body: bytes, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer } : null;
  },
  async head(key) {
    return objects.has(key) ? { size: objects.get(key).byteLength } : null;
  },
  async list({ prefix }) {
    return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  },
  async delete(keys) {
    for (const key of [].concat(keys)) {
      deletedKeys.push(key);
      objects.delete(key);
    }
  },
};
const route = await import("../app/api/divergences/[id]/items/[itemId]/attachments/route.ts");
const fileRoute = await import("../app/api/divergences/[id]/items/[itemId]/attachments/file/route.ts");
const detailRoute = await import("../app/api/divergences/[id]/route.ts");

const ADM = { id: "estoque", permissions: ["divergencias:view", "divergencias:respond"] };
const LOJA_A = { id: "lojaa", companyId: "clojaalfa1", permissions: ["divergencias:view", "divergencias:create"] };
const LOJA_A2 = { id: "lojaa2", companyId: "clojaalfa1", permissions: ["divergencias:view"] };
const LOJA_B = { id: "lojab", companyId: "clojabeta1", permissions: ["divergencias:view", "divergencias:create"] };

db.insert("divergence_requests", { id: "r1", company_id: "clojaalfa1", company_name: "LOJA A" });
db.insert("divergence_items", { id: "i1", request_id: "r1", product_name: "CONTROLE", status: "verificacao_loja" });

const base = "/api/divergences/r1/items/i1/attachments";
const params = { id: "r1", itemId: "i1" };

async function upload(user, side, { name = "foto.png", type = "image/png", bytes = new Uint8Array([1, 2, 3, 4]) } = {}) {
  const created = await callRoute(route.POST, user, "POST", base, {
    action: "create", side, fileName: name, contentType: type, fileSize: bytes.byteLength, numberOfParts: 1,
  }, params);
  if (created.status !== 201) return created;
  const sessionId = (await created.json()).session.id;
  const chunk = await route.POST(new Request(`http://127.0.0.1${base}`, {
    method: "POST",
    headers: {
      "x-unigames-user-id": user.id, "x-unigames-company-id": user.companyId || "",
      "x-unigames-permissions": user.permissions.join(","), "sec-fetch-site": "same-origin",
      "content-type": "application/octet-stream", "x-divergence-upload-id": sessionId, "x-divergence-part-number": "1",
    },
    body: bytes,
  }), { params: Promise.resolve(params) });
  assert.equal(chunk.status, 200);
  return callRoute(route.POST, user, "POST", base, { action: "complete", sessionId }, params);
}
const del = (user, attachmentId) => callRoute(route.DELETE, user, "DELETE", `${base}?attachmentId=${attachmentId}`, undefined, params);
const list = async (user) => (await (await callRoute(route.GET, user, "GET", base, undefined, params)).json()).attachments;
const keyOf = (id) => db.sqlite.prepare("SELECT r2_key AS k FROM divergence_item_attachments WHERE id=?").get(id)?.k;

let lojaId = "";
let admId = "";

test("loja anexa no próprio item; chave no R2 por pedido/item; histórico registra", async () => {
  const response = await upload(LOJA_A, "loja");
  assert.equal(response.status, 201);
  lojaId = (await response.json()).id;
  assert.match(keyOf(lojaId), new RegExp(`^divergences/r1/i1/${lojaId}-foto\\.png$`));
  assert.ok(objects.has(keyOf(lojaId)));
  const [attachment] = await list(LOJA_A);
  assert.equal(attachment.side, "loja");
  assert.equal(attachment.fileName, "foto.png", "nome original do arquivo preservado");
  const event = db.sqlite.prepare("SELECT kind, text FROM divergence_item_events WHERE item_id='i1'").get();
  assert.equal(event.kind, "attachment");
  assert.match(event.text, /LOJA: FOTO\.PNG/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM divergence_item_events WHERE kind='attachment'").get().n, 1);
});

test("loja de outra loja: 404; loja no lado ADM: 403; ADM anexa PDF", async () => {
  assert.equal((await upload(LOJA_B, "loja")).status, 404);
  assert.equal((await upload(LOJA_B, "adm")).status, 404);
  assert.equal((await upload(LOJA_A, "adm")).status, 403);
  assert.equal((await callRoute(route.GET, LOJA_B, "GET", base, undefined, params)).status, 404);
  const response = await upload(ADM, "adm", { name: "nota.pdf", type: "application/pdf" });
  assert.equal(response.status, 201);
  admId = (await response.json()).id;
  assert.deepEqual((await list(ADM)).map((a) => a.side), ["loja", "adm"]);
});

test("tipo inválido: 400", async () => {
  assert.equal((await upload(LOJA_A, "loja", { name: "x.txt", type: "text/plain" })).status, 400);
  assert.equal((await upload(LOJA_A, "loja", { name: "x.gif", type: "image/gif" })).status, 400);
});

test("arquivo abre para quem vê o pedido; outra loja recebe 404", async () => {
  const path = `${base}/file?attachmentId=${lojaId}`;
  const ok = await callRoute(fileRoute.GET, LOJA_A, "GET", path, undefined, params);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal((await callRoute(fileRoute.GET, LOJA_B, "GET", path, undefined, params)).status, 404);
});

test("detalhe do pedido traz os anexos de cada item", async () => {
  const body = await (await callRoute(detailRoute.GET, LOJA_A, "GET", "/api/divergences/r1", undefined, { id: "r1" })).json();
  assert.deepEqual(body.items[0].attachments.map((a) => a.id), [lojaId, admId]);
});

test("excluir: outro usuário 403, dono OK, ADM exclui qualquer; apaga a chave no R2", async () => {
  assert.equal((await del(LOJA_A2, lojaId)).status, 403);
  assert.equal((await del(LOJA_A, admId)).status, 403, "loja não exclui anexo do ADM");
  const second = (await (await upload(LOJA_A2, "loja", { name: "b.jpg", type: "image/jpeg" })).json()).id;

  const ownKey = keyOf(lojaId);
  const own = await del(LOJA_A, lojaId);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).name, "foto.png", "nome vai para a Auditoria");
  assert.ok(deletedKeys.includes(ownKey) && !objects.has(ownKey));

  const otherKey = keyOf(second);
  assert.equal((await del(ADM, second)).status, 200);
  assert.ok(deletedKeys.includes(otherKey) && !objects.has(otherKey));
  assert.equal((await del(ADM, second)).status, 404, "já excluído");
  assert.deepEqual((await list(ADM)).map((a) => a.id), [admId]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM divergence_item_events WHERE kind='attachment_delete'").get().n, 2);
});

test("excluir o pedido apaga os anexos (R2 + registro)", async () => {
  const key = keyOf(admId);
  const response = await callRoute(detailRoute.DELETE, { id: "master", role: "admin" }, "DELETE", "/api/divergences/r1", undefined, { id: "r1" });
  assert.equal(response.status, 200);
  assert.ok(!objects.has(key));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM divergence_item_attachments").get().n, 0);
});
