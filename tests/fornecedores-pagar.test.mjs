import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro > Fornecedores a Pagar (0140): pedido com moeda, vencimento pelo
// prazo do fornecedor, vários pagamentos até o total, programação livre,
// anexos no R2. Interno: login com loja não vê.

const db = await setupRouteDb(["ap_simple_options", "ap_simple_entries", "ap_simple_payments", "ap_simple_attachments"]);
// R2 falso em memória (mesmo das divergências) para o anexo.
const objects = new Map();
globalThis.__routeTestBucket = {
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
    for (const key of [].concat(keys)) objects.delete(key);
  },
};
const route = await import("../app/api/fornecedores-pagar/route.ts");
const files = await import("../app/api/fornecedores-pagar/attachment/route.ts");

const FIN = { id: "fin", name: "ANA FIN", permissions: ["fornecedores_pagar:view", "fornecedores_pagar:create", "fornecedores_pagar:pay"] };
const LEITOR = { id: "leitor", name: "LEITOR", permissions: ["fornecedores_pagar:view"] };
const LOJA = { id: "loja", name: "LOJA", companyId: "clojaalfa1", permissions: FIN.permissions };
const call = (actor, method, body) => callRoute(route[method], actor, method, "/api/fornecedores-pagar", body);
const list = async () => (await call(FIN, "GET")).json();
const byId = async () => Object.fromEntries((await list()).items.map((row) => [row.id, row]));

test("pedido com moeda, vencimento pelo prazo, vários pagamentos, programação e lote", async () => {
  assert.equal((await call(LOJA, "GET")).status, 403, "login com loja não vê");
  assert.equal((await call(LEITOR, "POST", { kind: "fornecedor", name: "x" })).status, 403);

  const sup = (await (await call(FIN, "POST", { kind: "fornecedor", name: "distribuidora alfa", paymentDays: "30" })).json()).id;
  const semPrazo = (await (await call(FIN, "POST", { kind: "fornecedor", name: "beta importação" })).json()).id;
  assert.equal((await call(FIN, "POST", { kind: "fornecedor", name: "DISTRIBUIDORA ALFA" })).status, 409, "duplicado");
  assert.equal((await call(FIN, "POST", { kind: "tipo", name: "pix" })).status, 400, "tipo de pagamento saiu");
  assert.equal((await call(FIN, "POST", { kind: "fornecedor", name: "gama", paymentDays: 999 })).status, 400);

  assert.equal((await call(FIN, "POST", { supplierId: sup, amountCents: 100, orderDate: "2026-11-01", currency: "EUR" })).status, 400, "moeda");
  assert.equal((await call(FIN, "POST", { supplierId: sup, amountCents: 0, orderDate: "2026-11-01" })).status, 400);
  const make = async (supplierId, orderDate, amountCents, currency) =>
    (await (await call(FIN, "POST", { supplierId, orderDate, amountCents, currency, notes: "pedido 12" })).json()).id;
  const a = await make(sup, "2026-11-01", 15000);
  const b = await make(sup, "2026-11-03", 2500, "USD");
  const c = await make(semPrazo, "2026-11-05", 990);

  let by = await byId();
  assert.equal(by[a].currency, "BRL", "padrão REAL");
  assert.equal(by[b].currency, "USD");
  assert.equal(by[a].notes, "PEDIDO 12");
  assert.equal(by[a].dueDate, "2026-12-01", "pedido + 30 dias");
  assert.equal(by[c].dueDate, "", "sem prazo");
  assert.equal(by[a].scheduledDate, "", "programação começa vazia");
  assert.deepEqual((await list()).suppliers.map((row) => [row.name, row.paymentDays]), [["BETA IMPORTAÇÃO", null], ["DISTRIBUIDORA ALFA", 30]]);

  // Prazo mudou → vencimento recalculado.
  assert.equal((await call(FIN, "PATCH", { action: "supplier", optionId: semPrazo, paymentDays: 10 })).status, 200);
  assert.equal((await byId())[c].dueDate, "2026-11-15");
  assert.equal((await call(FIN, "PATCH", { action: "supplier", optionId: semPrazo, paymentDays: "" })).status, 200);
  assert.equal((await byId())[c].dueDate, "");

  // Vários pagamentos até o total; não passa do total.
  assert.equal((await call(LEITOR, "PATCH", { action: "payment", id: a, amountCents: 100, paidDate: "2026-11-02" })).status, 403);
  assert.equal((await call(FIN, "PATCH", { action: "payment", id: a, amountCents: 5000, paidDate: "2099-01-01" })).status, 400, "futuro");
  assert.equal((await call(FIN, "PATCH", { action: "payment", id: a, amountCents: 5000, paidDate: "2026-11-02", notes: "entrada" })).status, 200);
  assert.equal((await call(FIN, "PATCH", { action: "payment", id: a, amountCents: 10001, paidDate: "2026-11-04" })).status, 400, "passa do total");
  by = await byId();
  assert.equal(by[a].paidCents, 5000);
  assert.equal(by[a].status, "aberto");
  assert.equal(by[a].payments[0].notes, "ENTRADA");
  assert.equal((await call(FIN, "PATCH", { action: "payment", id: a, amountCents: 10000, paidDate: "2026-11-04" })).status, 200);
  by = await byId();
  assert.equal(by[a].status, "pago", "quitado quando soma = total");
  assert.equal(by[a].payments.length, 2);
  assert.equal((await call(FIN, "PATCH", { action: "edit", id: a, supplierId: sup, amountCents: 14000, orderDate: "2026-11-01" })).status, 400, "total < pago");

  // Excluir um pagamento: volta a ficar em aberto e guarda quem excluiu.
  const wrong = by[a].payments[1].id;
  assert.equal((await call(FIN, "PATCH", { action: "unpayment", paymentId: wrong })).status, 200);
  assert.equal((await call(FIN, "PATCH", { action: "unpayment", paymentId: wrong })).status, 404);
  assert.equal((await byId())[a].status, "aberto");
  assert.equal(db.sqlite.prepare("SELECT deleted_by_name AS who FROM ap_simple_payments WHERE id=?").get(wrong).who, "ANA FIN");

  // Programação livre: data, troca, vazio.
  assert.equal((await call(FIN, "PATCH", { action: "reschedule", ids: [a, b], scheduledDate: "2026-11-10" })).status, 200);
  assert.equal((await byId())[b].scheduledDate, "2026-11-10");
  assert.equal((await call(FIN, "PATCH", { action: "reschedule", ids: [b], scheduledDate: "" })).status, 200);
  assert.equal((await byId())[b].scheduledDate, "");

  // Lote: quita o que falta. a na programada (10/11), b sem data → hoje, c em outra data.
  assert.equal((await call(FIN, "PATCH", { action: "pay", ids: [a, b] })).status, 200);
  assert.equal((await call(FIN, "PATCH", { action: "pay", ids: [c], paidDate: "2026-11-06" })).status, 200);
  by = await byId();
  assert.deepEqual(by[a].payments.map((row) => [row.amountCents, row.paidDate]), [[5000, "2026-11-02"], [10000, "2026-11-10"]]);
  assert.equal(by[b].paidCents, 2500);
  assert.ok(by[b].payments[0].paidDate > "2026-11-15", "sem programação → hoje");
  assert.equal(by[c].payments[0].paidDate, "2026-11-06");
  assert.ok([a, b, c].every((id) => by[id].status === "pago"));
  assert.equal((await (await call(FIN, "PATCH", { action: "pay", ids: [a] })).json()).skipped, 1, "já quitado");

  // Cadastro excluído: some das opções ativas, nome continua.
  assert.equal((await call(FIN, "DELETE", { optionId: sup })).status, 200);
  assert.equal((await list()).suppliers.find((row) => row.id === sup).active, false);

  assert.equal((await call(FIN, "DELETE", { ids: [a, b] })).status, 403, "sem permissão de excluir");
  assert.equal((await call({ ...FIN, permissions: ["fornecedores_pagar:delete"] }, "DELETE", { ids: [a, b] })).status, 200);
  assert.equal((await list()).items.length, 1);
});

test("migration 0140: pagos viram 1 pagamento, em aberto copiam a data para a programação", async () => {
  const sql = await readFile(new URL("../drizzle/0140_fornecedores_pagar_pedidos.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /DROP|DELETE FROM/i, "nada é apagado");
  assert.match(sql, /INSERT INTO "ap_simple_payments"[\s\S]*WHERE "status" = 'pago'[\s\S]*ON CONFLICT \("id"\) DO NOTHING/);
  assert.match(sql, /SET "scheduled_date" = "planned_date" WHERE "status" = 'aberto'/);
  assert.match(sql, /"currency" text DEFAULT 'BRL' NOT NULL/);
});

test("anexo do pedido: tipos aceitos, envio em partes no R2, abrir e excluir", async () => {
  const sup = (await (await call(FIN, "POST", { kind: "fornecedor", name: "anexo ltda" })).json()).id;
  const entryId = (await (await call(FIN, "POST", { supplierId: sup, amountCents: 500, orderDate: "2026-11-10" })).json()).id;
  const up = (actor, method, body) => callRoute(files[method], actor, method, "/api/fornecedores-pagar/attachment", body);
  const bytes = new TextEncoder().encode("a;b\n1;2\n");
  const meta = { action: "create", entryId, fileName: "pedido.csv", contentType: "text/csv", fileSize: bytes.length, numberOfParts: 1 };
  assert.equal((await up(FIN, "POST", { ...meta, fileName: "pedido.exe" })).status, 400, "tipo não aceito");
  assert.equal((await up(LEITOR, "POST", meta)).status, 403);
  const session = (await (await up(FIN, "POST", meta)).json()).session.id;
  const chunk = await files.POST(new Request("http://127.0.0.1/api/fornecedores-pagar/attachment", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-fpg-upload-id": session, "x-fpg-part-number": "1",
      "x-unigames-user-id": "fin", "x-unigames-display-name": "ANA%20FIN", "x-unigames-permissions": FIN.permissions.join(","), "sec-fetch-site": "same-origin" },
    body: bytes,
  }));
  assert.equal(chunk.status, 200);
  assert.equal((await up(FIN, "POST", { action: "complete", sessionId: session })).status, 201);
  const file = (await byId())[entryId].attachments[0];
  assert.equal(file.fileName, "pedido.csv");
  const opened = await callRoute(files.GET, LEITOR, "GET", `/api/fornecedores-pagar/attachment?id=${file.id}`);
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), "a;b\n1;2\n");
  assert.equal((await callRoute(files.GET, LOJA, "GET", `/api/fornecedores-pagar/attachment?id=${file.id}`)).status, 403);
  assert.equal((await up(FIN, "DELETE", { attachmentId: file.id })).status, 200);
  assert.equal((await byId())[entryId].attachments.length, 0);
});

test("tela: menu no Financeiro, abas, filtros, moeda, anexo, imagem", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /data-page="fornecedoresPagar" data-permission="fornecedores_pagar"/);
  assert.match(html, /data-fpg-tab="programacao">PROGRAMAÇÃO DE PGTOS</);
  for (const id of ["fpgFilterSupplier", "fpgFilterStatus", "fpgFilterDue", "fpgCurrency", "fpgFile", "fpgNotes", "btnFpgImage", "fpgOrderDialog", "fpgNewDays"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="fpgFilterType"|id="fpgType"|TIPO DE PAGAMENTO \*/, "tipo de pagamento saiu da tela");
  for (const value of ["vencidos", "hoje", "7", "15", "30", "sem"]) assert.match(html, new RegExp(`id="fpgFilterDue">[\\s\\S]*?<option value="${value}"`));
  for (const action of ["pay", "reschedule", "delete"]) assert.match(html, new RegExp(`data-fpg-bulk="${action}"`));
  assert.match(html, /<option value="planned">PAGO NA DATA PROGRAMADA<\/option>/);
  assert.match(html, /async function fpgBuildImage[\s\S]*?comDrawImageFrame/);
});
