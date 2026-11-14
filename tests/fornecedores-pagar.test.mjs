import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro > Fornecedores a Pagar: cadastros próprios (fornecedor/tipo),
// um pagamento por lançamento, pago na data programada ou em outra, lote.
// Interno: login com loja não vê.

await setupRouteDb(["ap_simple_options", "ap_simple_entries"]);
const route = await import("../app/api/fornecedores-pagar/route.ts");

const FIN = { id: "fin", name: "ANA FIN", permissions: ["fornecedores_pagar:view", "fornecedores_pagar:create", "fornecedores_pagar:pay"] };
const LEITOR = { id: "leitor", name: "LEITOR", permissions: ["fornecedores_pagar:view"] };
const LOJA = { id: "loja", name: "LOJA", companyId: "clojaalfa1", permissions: FIN.permissions };
const call = (actor, method, body) => callRoute(route[method], actor, method, "/api/fornecedores-pagar", body);
const list = async () => (await call(FIN, "GET")).json();

test("cadastros, lançamento, pagar na data programada/outra data, lote e exclusão", async () => {
  assert.equal((await call(LOJA, "GET")).status, 403, "login com loja não vê");
  assert.equal((await call(LEITOR, "POST", { kind: "fornecedor", name: "x" })).status, 403);

  const sup = (await (await call(FIN, "POST", { kind: "fornecedor", name: "distribuidora alfa" })).json()).id;
  assert.equal((await call(FIN, "POST", { kind: "fornecedor", name: "DISTRIBUIDORA ALFA" })).status, 409, "duplicado");
  const pix = (await (await call(FIN, "POST", { kind: "tipo", name: "pix" })).json()).id;
  assert.equal((await call(FIN, "POST", { kind: "x", name: "y" })).status, 400);

  assert.equal((await call(FIN, "POST", { supplierId: pix, paymentTypeId: pix, amountCents: 100, plannedDate: "2026-11-01" })).status, 400, "tipo no lugar do fornecedor");
  assert.equal((await call(FIN, "POST", { supplierId: sup, paymentTypeId: pix, amountCents: 0, plannedDate: "2026-11-01" })).status, 400);
  const make = async (plannedDate, amountCents) =>
    (await (await call(FIN, "POST", { supplierId: sup, paymentTypeId: pix, amountCents, plannedDate, notes: "pedido 12" })).json()).id;
  const a = await make("2026-11-01", 15000);
  const b = await make("2026-11-03", 2500);
  const c = await make("2099-01-01", 990);

  let data = await list();
  assert.equal(data.items.length, 3);
  assert.equal(data.items.find((row) => row.id === a).notes, "PEDIDO 12");
  assert.deepEqual(data.suppliers.map((row) => row.name), ["DISTRIBUIDORA ALFA"]);

  assert.equal((await call(LEITOR, "PATCH", { action: "pay", ids: [a] })).status, 403);
  assert.equal((await call(FIN, "PATCH", { action: "pay", ids: [b], paidDate: "2099-01-01" })).status, 400, "pagamento futuro");
  // Lote sem data: cada um pago na própria data programada; futuro vira hoje.
  assert.equal((await call(FIN, "PATCH", { action: "pay", ids: [a, c] })).status, 200);
  assert.equal((await call(FIN, "PATCH", { action: "pay", ids: [b], paidDate: "2026-11-05" })).status, 200);
  data = await list();
  const by = Object.fromEntries(data.items.map((row) => [row.id, row]));
  assert.equal(by[a].paidDate, "2026-11-01");
  assert.equal(by[b].paidDate, "2026-11-05");
  assert.equal(by[a].status, "pago");
  assert.ok(by[c].paidDate < "2099-01-01", "programado no futuro → pago hoje");
  assert.equal(by[a].paidByName, "ANA FIN");

  const again = await (await call(FIN, "PATCH", { action: "pay", ids: [a] })).json();
  assert.equal(again.skipped, 1, "um pagamento só");
  assert.equal((await (await call(FIN, "PATCH", { action: "reschedule", ids: [a], plannedDate: "2026-12-01" })).json()).skipped, 1, "pago não reprograma");

  assert.equal((await call(FIN, "PATCH", { action: "unpay", ids: [a, b] })).status, 200);
  assert.equal((await call(FIN, "PATCH", { action: "reschedule", ids: [a, b], plannedDate: "2026-12-10" })).status, 200);
  assert.equal((await call(FIN, "PATCH", { action: "edit", id: a, supplierId: sup, paymentTypeId: pix, amountCents: 16000, plannedDate: "2026-12-11", notes: "" })).status, 200);
  data = await list();
  assert.deepEqual(data.items.filter((row) => row.status === "aberto").map((row) => row.plannedDate).sort(), ["2026-12-10", "2026-12-11"]);

  // Cadastro excluído: some das opções ativas, nome continua no lançamento.
  assert.equal((await call(FIN, "DELETE", { optionId: sup })).status, 200);
  assert.equal((await call(FIN, "DELETE", { optionId: sup })).status, 404);
  data = await list();
  assert.equal(data.suppliers[0].active, false);
  assert.equal(data.suppliers[0].name, "DISTRIBUIDORA ALFA");

  assert.equal((await call(FIN, "DELETE", { ids: [a, b] })).status, 403, "sem permissão de excluir");
  assert.equal((await call({ ...FIN, permissions: ["fornecedores_pagar:delete"] }, "DELETE", { ids: [a, b] })).status, 200);
  assert.equal((await list()).items.length, 1);
});

test("tela: menu no Financeiro, abas, filtros e lote", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /data-page="fornecedoresPagar" data-permission="fornecedores_pagar"/);
  assert.match(html, /data-fpg-tab="programacao">PROGRAMAÇÃO DE PGTOS</);
  for (const id of ["fpgFilterSupplier", "fpgFilterStatus", "fpgFilterType", "fpgNotes"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const action of ["pay", "unpay", "reschedule", "delete"]) assert.match(html, new RegExp(`data-fpg-bulk="${action}"`));
  assert.match(html, /<option value="planned">PAGO NA DATA PROGRAMADA<\/option>/);
});
