import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Estoque > Recebimento (0147): página nova sobre os pedidos do Compras, sem
// alterar o módulo. Loja não recebe NENHUM valor, só vê a própria loja de
// chegada, só confere depois da nota, corrige com motivo, para no CONCLUÍDO,
// grava a quantidade real (pode passar do pedido), aceita mais de uma NF por
// compra e NUNCA muda o status do pedido.

const db = await setupRouteDb([
  "shared_state", "purchase_orders", "purchase_order_items", "purchase_order_attachments", "purchase_receipts",
  "finance_suppliers", "supplier_invoices", "app_users",
]);
const bucketObjects = new Map();
globalThis.__routeTestBucket = {
  async put(key, bytes) { bucketObjects.set(key, bytes); },
  async get(key) { return bucketObjects.has(key) ? { body: bucketObjects.get(key) } : null; },
  async delete(key) { bucketObjects.delete(key); },
};
const list = await import("../app/api/recebimento/route.ts");
const one = await import("../app/api/recebimento/[id]/route.ts");
const comprasItem = await import("../app/api/compras-novo/orders/[id]/items/[itemId]/route.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: A, name: "LOJA GUARARAPES" }, { id: B, name: "LOJA RIOMAR" }]) });
db.insert("finance_suppliers", { id: "sup1", name: "DISTRIBUIDORA ALFA", created_by: "x" });

const LOJA_A = { id: "loja-a", name: "LOJA GUARARAPES", companyId: A, permissions: ["recebimento:loja"] };
const LOJA_B = { id: "loja-b", name: "LOJA RIOMAR", companyId: B, permissions: ["recebimento:loja"] };
const RENATO = { id: "renato", name: "RENATO", permissions: ["recebimento:acompanhar"] };
const NADA = { id: "x", name: "X", permissions: [] };
const PDF = new TextEncoder().encode("%PDF-1.4\n%nota\n");

function order(id, { company = A, status = "aguardando_chegada", canceled = 0, items = [] } = {}) {
  db.insert("purchase_orders", {
    id, origin: "native", supplier_id: "sup1", company_id: company, company_name: company === A ? "LOJA GUARARAPES" : "LOJA RIOMAR",
    order_date: "2026-11-20", expected_date: "2026-11-01", status, canceled, division: "DIVISÃO SECRETA R$ 999,00",
    division_status: "FALTA DIVISÃO", created_by: "renato",
  });
  for (const [itemId, quantity] of items) {
    db.insert("purchase_order_items", {
      id: itemId, order_id: id, product_code: itemId.toUpperCase(), product_name: `PRODUTO ${itemId.toUpperCase()}`,
      quantity, unit_price_cents: 28990, created_by: "renato",
    });
  }
}
order("po1", { items: [["i1", 10], ["i2", 5], ["i3", 2]] });
order("po2", { items: [["i4", 1]] });
order("po3", { company: B, items: [["i5", 4]] });
order("po-aberto", { status: "aberto", items: [["i6", 1]] });
order("po-cancelado", { canceled: 1, items: [["i7", 1]] });

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
  return Response.json({ id: `email-${sent.length}` });
};

const headers = (actor) => ({
  "x-unigames-user-id": actor.id, "x-unigames-display-name": encodeURIComponent(actor.name), "x-unigames-role": "user",
  "x-unigames-company-id": actor.companyId || "", "x-unigames-permissions": actor.permissions.join(","), "sec-fetch-site": "same-origin",
});
const nota = (actor, id, nfNumber = "123456", body = PDF) => one.POST(
  new Request(`http://127.0.0.1/api/recebimento/${id}?nfNumber=${nfNumber}`, {
    method: "POST", headers: { ...headers(actor), "content-type": "application/pdf" }, body,
  }),
  { params: Promise.resolve({ id }) },
);
const act = (actor, id, body) => callRoute(one.POST, actor, "POST", `/api/recebimento/${id}`, body, { id });
const pdf = (actor, id) => callRoute(one.GET, actor, "GET", `/api/recebimento/${id}`, undefined, { id });
const view = async (actor) => (await callRoute(list.GET, actor, "GET", "/api/recebimento")).json();
const item = (id) => db.sqlite.prepare("SELECT quantity, received_quantity AS rq FROM purchase_order_items WHERE id=?").get(id);
const po = (id) => db.sqlite.prepare("SELECT status, received_date AS rd FROM purchase_orders WHERE id=?").get(id);

test("sem permissão: 403; loja vê só a própria loja e só aguardando/concluído", async () => {
  assert.equal((await callRoute(list.GET, NADA, "GET", "/api/recebimento")).status, 403);
  const loja = await view(LOJA_A);
  assert.deepEqual(loja.orders.map((o) => o.id).sort(), ["po1", "po2"]);
  assert.equal(loja.canFollow, false);
  assert.equal(loja.emails, undefined);
  assert.equal(loja.orders[0].supplierName, "DISTRIBUIDORA ALFA");
  assert.equal(loja.orders.find((o) => o.id === "po1").late, true);
  assert.deepEqual((await view(RENATO)).orders.map((o) => o.id).sort(), ["po1", "po2", "po3"]);
  // Pedido de outra loja: mesmo 404 de "não encontrado".
  assert.equal((await nota(LOJA_A, "po3")).status, 404);
  assert.equal((await nota(LOJA_A, "po-aberto")).status, 404);
  assert.equal((await nota(LOJA_A, "po-cancelado")).status, 404);
});

test("nenhum campo de valor sai do servidor (loja e Compras)", async () => {
  for (const actor of [LOJA_A, RENATO]) {
    const text = JSON.stringify(await view(actor));
    for (const forbidden of ["price", "Price", "cents", "Cents", "cost", "total", "division\"", "DIVISÃO SECRETA", "999", "28990", "289"]) {
      assert.ok(!text.includes(forbidden), `${actor.id} recebeu "${forbidden}"`);
    }
  }
});

test("não confere sem nota; nota vira anexo 'nota_fiscal' + e-mail; loja não reabre o PDF", async () => {
  assert.equal((await act(LOJA_A, "po1", { action: "conferir", items: [] })).status, 409);
  delete process.env.RESEND_RECEBIMENTO_API_KEY;
  assert.equal((await nota(LOJA_A, "po1", "")).status, 400);
  assert.equal((await nota(LOJA_A, "po1", "1", new TextEncoder().encode("oi"))).status, 400);
  assert.equal((await nota(RENATO, "po1")).status, 403);

  process.env.RESEND_RECEBIMENTO_API_KEY = "re_teste";
  const ok = await nota(LOJA_A, "po1", "NF 123.456");
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).emailSent, true);
  const attachment = db.sqlite.prepare("SELECT attachment_type AS t, file_name AS f, uploaded_by_name AS by FROM purchase_order_attachments WHERE order_id='po1'").get();
  assert.deepEqual({ ...attachment }, { t: "nota_fiscal", f: "NF-123456-LOJA-GUARARAPES.pdf", by: "LOJA GUARARAPES" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].auth, "Bearer re_teste");
  assert.equal(sent[0].body.from, "Unigames Recebimento <recebimento@unigameslojas.com>");
  assert.deepEqual(sent[0].body.to, ["financeiro@unigameslojas.com"]);
  assert.deepEqual(sent[0].body.cc, ["douglas@unigameslojas.com", "renatofreire.unigames@gmail.com"]);
  assert.equal(sent[0].body.subject, "CHEGADA DE COMPRA · LOJA GUARARAPES · DISTRIBUIDORA ALFA · NF 123456");
  assert.equal(Buffer.from(sent[0].body.attachments[0].content, "base64").toString(), "%PDF-1.4\n%nota\n");

  assert.equal((await nota(LOJA_A, "po1", "123456")).status, 409, "mesma NF duas vezes");
  assert.equal((await nota(LOJA_A, "po1", "654321")).status, 201, "segunda NF da mesma compra");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.subject, "CHEGADA DE COMPRA · LOJA GUARARAPES · DISTRIBUIDORA ALFA · NF 654321");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM purchase_order_attachments WHERE order_id='po1' AND attachment_type='nota_fiscal'").get().n, 2);
  assert.equal((await pdf(LOJA_A, "po1")).status, 403);
  const opened = await pdf(RENATO, "po1");
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("content-type"), "application/pdf");

  const loja = (await view(LOJA_A)).orders.find((o) => o.id === "po1");
  assert.equal(loja.nfNumber, "123456, 654321");
  assert.deepEqual(loja.notas.map((n) => [n.nfNumber, n.attachmentId]), [["123456", undefined], ["654321", undefined]]);
  assert.equal(loja.steps.nota, true);
  assert.ok(!loja.history.some((h) => h.type === "email"), "loja não vê os e-mails");
  const compras = (await view(RENATO)).orders.find((o) => o.id === "po1");
  assert.equal(compras.history.find((h) => h.type === "email").ok, true);
  const second = await callRoute(one.GET, RENATO, "GET", `/api/recebimento/po1?anexo=${compras.notas[1].attachmentId}`, undefined, { id: "po1" });
  assert.equal(second.status, 200);
  assert.equal((await callRoute(one.GET, RENATO, "GET", "/api/recebimento/po1?anexo=outro", undefined, { id: "po1" })).status, 404);
});

test("conferência: todos os itens, quantidade real (a mais também), status não muda", async () => {
  const items = [
    { itemId: "i1", counted: 12 },
    { itemId: "i2", counted: 3 },
    { itemId: "i3", counted: 2, divergence: "cor_diferente" },
  ];
  assert.equal((await act(LOJA_A, "po1", { action: "conferir", items: items.slice(0, 2) })).status, 400, "falta item");
  assert.equal((await act(LOJA_A, "po1", { action: "conferir", items: [...items.slice(0, 2), { itemId: "i3", counted: "" }] })).status, 400);
  assert.equal((await act(LOJA_A, "po1", { action: "conferir", items })).status, 400, "cor diferente sem observação");
  items[2].note = "veio azul";
  const extras = [{ productName: "cabo hdmi", quantity: 1 }];
  assert.equal((await act(RENATO, "po1", { action: "conferir", items, extras })).status, 403);
  const ok = await act(LOJA_A, "po1", { action: "conferir", items, extras });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).divergences, 4);
  assert.deepEqual({ ...item("i1") }, { quantity: 10, rq: 12 }, "quantidade real, acima do pedido");
  assert.equal(item("i2").rq, 3);
  assert.equal(po("po1").status, "aguardando_chegada", "a página nunca conclui");
  assert.match(po("po1").rd, /^\d{4}-\d{2}-\d{2}$/);
  const o = (await view(LOJA_A)).orders.find((x) => x.id === "po1");
  const byId = Object.fromEntries(o.items.map((x) => [x.id, x]));
  assert.equal(byId.i1.excess, 2);
  assert.equal(byId.i1.divergence, "veio_a_mais");
  assert.equal(byId.i2.divergence, "faltou");
  assert.equal(byId.i3.divergence, "cor_diferente");
  assert.equal(byId.i3.note, "VEIO AZUL");
  assert.deepEqual(o.extras, [{ productName: "CABO HDMI", quantity: 1, note: "" }]);
  assert.equal(o.late, false);
  assert.equal((await act(LOJA_A, "po1", { action: "conferir", items })).status, 409, "conferência só uma vez");
  assert.equal((await nota(LOJA_A, "po1", "111")).status, 201, "NF atrasada ainda entra antes do CONCLUÍDO");
});

test("correção exige motivo e fica no histórico; Compras mexendo direto aparece", async () => {
  assert.equal((await act(LOJA_A, "po1", { action: "corrigir", itemId: "i2", counted: 5 })).status, 400);
  assert.equal((await act(LOJA_A, "po1", { action: "corrigir", itemId: "i2", counted: 5, reason: "ok" })).status, 400);
  const ok = await act(LOJA_A, "po1", { action: "corrigir", itemId: "i2", counted: 5, reason: "caixa estava no estoque" });
  assert.equal(ok.status, 200);
  assert.equal(item("i2").rq, 5);
  let o = (await view(LOJA_A)).orders.find((x) => x.id === "po1");
  const fixed = o.items.find((x) => x.id === "i2");
  assert.equal(fixed.divergence, "");
  const h = o.history.find((x) => x.type === "correcao");
  assert.deepEqual([h.from, h.to, h.reason, h.byName], [3, 5, "CAIXA ESTAVA NO ESTOQUE", "LOJA GUARARAPES"]);
  // Corrigir um item marcado à mão mantém a marcação.
  await act(LOJA_A, "po1", { action: "corrigir", itemId: "i3", counted: 1, reason: "contei de novo" });
  o = (await view(LOJA_A)).orders.find((x) => x.id === "po1");
  assert.equal(o.items.find((x) => x.id === "i3").divergence, "cor_diferente");

  db.sqlite.prepare("UPDATE purchase_order_items SET received_quantity=4 WHERE id='i2'").run();
  o = (await view(RENATO)).orders.find((x) => x.id === "po1");
  assert.equal(o.items.find((x) => x.id === "i2").changedByCompras, true);
});

test("CONCLUÍDO pelo Compras: loja não altera mais", async () => {
  db.sqlite.prepare("UPDATE purchase_orders SET status='concluido', updated_at=? WHERE id='po1'").run(new Date().toISOString());
  const o = (await view(LOJA_A)).orders.find((x) => x.id === "po1");
  assert.equal(o.steps.concluido, true);
  assert.equal((await act(LOJA_A, "po1", { action: "corrigir", itemId: "i2", counted: 1, reason: "tentativa depois" })).status, 409);
  assert.equal((await act(RENATO, "po1", { action: "loja", companyId: B })).status, 409);
});

test("troca da loja de chegada: só o Compras; a compra muda de loja", async () => {
  assert.equal((await act(LOJA_A, "po2", { action: "loja", companyId: B })).status, 403);
  assert.equal((await act(RENATO, "po2", { action: "loja", companyId: "cnaoexiste1" })).status, 400);
  assert.equal((await act(RENATO, "po2", { action: "loja", companyId: A })).status, 400, "já é a loja");
  assert.equal((await act(RENATO, "po2", { action: "loja", companyId: B })).status, 200);
  assert.ok(!(await view(LOJA_A)).orders.some((o) => o.id === "po2"));
  const moved = (await view(LOJA_B)).orders.find((o) => o.id === "po2");
  assert.equal(moved.deliveryCompanyName, "LOJA RIOMAR");
  assert.equal(moved.billingCompanyName, "LOJA GUARARAPES");
  assert.equal(moved.deliveryChanged, true);
  assert.equal((await nota(LOJA_A, "po2")).status, 404);
  assert.equal((await nota(LOJA_B, "po2", "777")).status, 201);
  assert.equal(sent.at(-1).body.subject, "CHEGADA DE COMPRA · LOJA RIOMAR · DISTRIBUIDORA ALFA · NF 777");
  // Volta para a loja que fatura: limpa a troca.
  assert.equal((await act(RENATO, "po2", { action: "loja", companyId: A })).status, 200);
  assert.equal((await view(LOJA_A)).orders.find((o) => o.id === "po2").deliveryChanged, false);
});

test("configuração dos 3 e-mails: só o Compras; próximo e-mail usa os novos", async () => {
  const put = (actor, emails) => callRoute(list.PUT, actor, "PUT", "/api/recebimento", { emails });
  assert.equal((await put(LOJA_A, ["a@x.com", "b@x.com", "c@x.com"])).status, 403);
  assert.equal((await put(RENATO, ["a@x.com", "b@x.com"])).status, 400);
  assert.equal((await put(RENATO, ["a@x.com", "b@x.com", "não é e-mail"])).status, 400);
  assert.equal((await put(RENATO, ["A@X.com", "b@x.com", "c@x.com"])).status, 200);
  assert.deepEqual((await view(RENATO)).emails, ["a@x.com", "b@x.com", "c@x.com"]);
  assert.equal((await nota(LOJA_B, "po3", "888")).status, 201);
  assert.deepEqual(sent.at(-1).body.to, ["a@x.com"]);
  assert.deepEqual(sent.at(-1).body.cc, ["b@x.com", "c@x.com"]);
});

test("e-mail recusado não perde a nota: fica registrado como não enviado", async () => {
  order("po4", { items: [["i8", 1]] });
  globalThis.fetch = async () => Response.json({ message: "domain not verified" }, { status: 403 });
  const res = await nota(LOJA_A, "po4", "999");
  assert.equal(res.status, 201);
  assert.equal((await res.json()).emailSent, false);
  const o = (await view(RENATO)).orders.find((x) => x.id === "po4");
  assert.equal(o.steps.nota, true);
  assert.equal(o.history.find((h) => h.type === "email").ok, false);
});

test("Compras aceita QTD RECEBIDA acima do pedido e conclui como antes", async () => {
  order("po5", { items: [["i9", 10]] });
  const COMPRAS = { id: "renato", name: "RENATO", permissions: ["purchases_draft:manage"] };
  const res = await callRoute(comprasItem.PATCH, COMPRAS, "PATCH", "/api/compras-novo/orders/po5/items/i9", { receivedQuantity: 12 }, { id: "po5", itemId: "i9" });
  assert.equal(res.status, 200);
  assert.equal(item("i9").rq, 12);
  assert.equal(po("po5").status, "concluido");
});

test("ao vivo: gravação no Recebimento avisa o módulo recebimento (o Worker avisa também o Compras)", async () => {
  const { liveInvalidationForRequest } = await import("../worker/live-events.ts");
  const req = (method, path) => new Request(`http://127.0.0.1${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
  assert.deepEqual(await liveInvalidationForRequest(req("POST", "/api/recebimento/po1"), { id: "x", companyId: "" }), { module: "recebimento", audience: { kind: "all" } });
  assert.deepEqual(await liveInvalidationForRequest(req("PUT", "/api/recebimento"), { id: "x", companyId: "" }), { module: "recebimento", audience: { kind: "all" } });
  assert.equal(await liveInvalidationForRequest(req("GET", "/api/recebimento"), { id: "x", companyId: "" }), null);
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /LIVE_TWINS[^=]*= \{ compras: "recebimento", recebimento: "compras" \}/);
});

test("resumo do Início: loja = a receber/atrasadas; Compras = chegaram/divergência; sem valores", async () => {
  order("po6", { company: B, items: [["i10", 3]] });
  const loja = await (await callRoute(list.GET, LOJA_B, "GET", "/api/recebimento?resumo=1")).json();
  assert.equal(loja.canFollow, false);
  assert.ok(loja.toReceive >= 1 && loja.late >= 1, JSON.stringify(loja));
  const compras = await (await callRoute(list.GET, RENATO, "GET", "/api/recebimento?resumo=1")).json();
  assert.equal(compras.canFollow, true);
  assert.deepEqual(Object.keys(compras).sort(), ["arrived", "canFollow", "divergent", "late", "toReceive"]);
});
