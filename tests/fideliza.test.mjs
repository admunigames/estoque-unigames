import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";
import { parsePdvReport, phoneKey, matchStore } from "../app/lib/fideliza.ts";

// Comercial > FIDELIZA: importação do Relatório de PDV (dados fictícios),
// clientes/recorrência/inativos, contatos e escopo por loja.

const db = await setupRouteDb(["shared_state", "fideliza_sales", "fideliza_contacts", "fideliza_imports"]);
const route = await import("../app/api/fideliza/route.ts");

const A = "clojaalfa1";
const B = "clojabeta2";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: A, name: "Riomar" }, { id: B, name: "Tacaruna" }]) });

const td = (cells) => "<tr>" + cells.map((cell) => `<td>${cell}</td>`).join("") + "</tr>";
const line = (no, status, date, name, phone, product, total) =>
  td([no, status, date, "00/00/0000", name, phone, "VENDEDOR X", "Tipo Pagamento: PIX", "123", product, "5102", total, "1", total, total]);
const report = (store, lines) =>
  `<html><body><table>${td([`UNIGAMES ${store}`])}${td(["Relat&oacute;rio de Pdv"])}${td([`Per&iacute;odo: 01/01/2026 - UNIGAMES ${store}`])}${lines.join("")}${td(["Valores Finais:", "Total Geral", "1.000,00"])}</table></body></html>`;

const TODAY = new Date().toISOString().slice(0, 10).split("-").reverse().join("/");
const FILE = report("RIOMAR", [
  line("100", "Finalizado", "10/01/2025", "Jo&atilde;o Antigo", "81 98888-1111", "PS4", "1.500,00"),
  line("101", "Finalizado", "05/02/2026", "Maria Recorrente", "819 9777-2222", "Controle", "350,00"),
  line("101", "Finalizado", "05/02/2026", "Maria Recorrente", "819 9777-2222", "Cabo", "350,00"),
  line("102", "Finalizado", TODAY, "Maria Recorrente", "(81) 99777-2222", "Jogo", "200,00"),
  line("103", "Finalizado", TODAY, "CLIENTES UNIGAMES", "00000000", "Jogo", "200,00"),
  line("104", "Cancelado", TODAY, "Pedro Cancelado", "81 97777-3333", "Jogo", "200,00"),
]);

const ADM = { id: "adm", name: "ADM FIDELIZA", permissions: ["fideliza:import", "fideliza:all_stores", "fideliza:view", "fideliza:manage"] };
const LOJA_A = { id: "la", name: "VENDEDOR A", companyId: A, permissions: ["fideliza:view", "fideliza:contact", "fideliza:all_stores", "fideliza:import"] };
const LOJA_B = { id: "lb", name: "VENDEDOR B", companyId: B, permissions: ["fideliza:view", "fideliza:contact"] };
const SEM_LOJA = { id: "sl", name: "SEM LOJA", permissions: ["fideliza:view"] };
const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/fideliza${query}`, body);

test("parser: telefone, loja do cabeçalho, só finalizadas identificadas", () => {
  assert.equal(phoneKey("819 9777-2222"), "81997772222");
  assert.equal(phoneKey("(81) 99777-2222"), "81997772222");
  assert.equal(phoneKey("8188881111"), "81988881111");
  assert.equal(phoneKey("98888-1111"), "81988881111");
  assert.equal(phoneKey("00000000"), "");
  assert.equal(phoneKey("+55 81 99777-2222"), "81997772222");
  const parsed = parsePdvReport(FILE);
  assert.equal(parsed.storeLabel, "RIOMAR");
  assert.equal(parsed.rows, 6);
  assert.equal(parsed.salesTotal, 5);
  assert.deepEqual(parsed.sales.map((sale) => sale.saleNo), ["100", "101", "102"]);
  assert.equal(parsed.sales[1].items.length, 2);
  assert.equal(parsed.sales[1].totalCents, 35000);
  assert.equal(parsed.sales[0].customerName, "JOÃO ANTIGO");
  assert.equal(parsed.sales[0].payment, "PIX");
  assert.equal(matchStore("NORTH WAY", [{ id: "x", name: "PNWS" }])?.id, "x");
});

test("importa (prévia → grava → reimporta sem duplicar), lista, contata e respeita a loja", async () => {
  assert.equal((await call(LOJA_B, "POST", { action: "import", text: FILE })).status, 403);
  // Loja A tem import, mas login com loja só importa a própria.
  assert.equal((await call(LOJA_A, "POST", { action: "import", companyId: B, text: FILE, preview: true })).status, 404);

  const preview = await (await call(ADM, "POST", { action: "import", text: FILE, fileName: "x.xls", preview: true })).json();
  assert.equal(preview.preview.storeId, A);
  assert.equal(preview.preview.salesNew, 3);
  assert.equal(preview.preview.customers, 2);
  assert.equal((await call(ADM, "POST", { action: "import", text: FILE, fileName: "x.xls" })).status, 201);
  const again = await (await call(ADM, "POST", { action: "import", text: FILE, fileName: "x.xls" })).json();
  assert.equal(again.preview.salesNew, 0);

  const home = await (await call(ADM, "GET")).json();
  assert.equal(home.stores.length, 2);
  assert.equal(home.imports.length, 2);
  assert.equal(home.can.contact, false);
  const homeA = await (await call(LOJA_A, "GET")).json();
  assert.deepEqual(homeA.stores.map((store) => store.id), [A]);
  assert.equal((await call(SEM_LOJA, "GET")).status, 200);
  assert.equal((await call(SEM_LOJA, "GET", undefined, `?view=clients&companyId=${A}`)).status, 404);
  assert.equal((await call(LOJA_B, "GET", undefined, `?view=clients&companyId=${A}`)).status, 404);

  const all = await (await call(LOJA_A, "GET", undefined, `?view=clients&companyId=${A}`)).json();
  assert.deepEqual(all.summary, { clients: 2, recurring: 1, inactive: 1 });
  assert.equal(all.clients[0].name, "MARIA RECORRENTE");
  assert.equal(all.clients[0].purchases, 2);
  assert.equal(all.clients[0].totalCents, 55000);
  const inactive = await (await call(LOJA_A, "GET", undefined, `?view=clients&companyId=${A}&segment=inativos`)).json();
  assert.deepEqual(inactive.clients.map((client) => client.key), ["81988881111"]);
  const search = await (await call(LOJA_A, "GET", undefined, `?view=clients&companyId=${A}&q=7772`)).json();
  assert.deepEqual(search.clients.map((client) => client.key), ["81997772222"]);
  const byName = await (await call(LOJA_A, "GET", undefined, `?view=clients&companyId=${A}&segment=recorrentes&q=maria`)).json();
  assert.equal(byName.clients.length, 1);

  const contact = (actor, body) => call(actor, "POST", { action: "contact", companyId: A, customerKey: "81988881111", ...body });
  assert.equal((await contact(ADM, { result: "sem_resposta" })).status, 403);
  assert.equal((await contact(LOJA_B, { result: "sem_resposta" })).status, 404);
  assert.equal((await contact(LOJA_A, { result: "xx" })).status, 400);
  assert.equal((await contact(LOJA_A, { result: "retorno_agendado", scheduledFor: "2000-01-01" })).status, 400);
  assert.equal((await contact(LOJA_A, { result: "sem_resposta", customerKey: "81900000000" })).status, 404);
  assert.equal((await contact(LOJA_A, { result: "retorno_agendado", scheduledFor: "2099-01-01", note: "ligar à tarde" })).status, 201);

  const agenda = await (await call(LOJA_A, "GET", undefined, `?view=agenda&companyId=${A}`)).json();
  assert.equal(agenda.pending.length, 1);
  assert.equal(agenda.pending[0].note, "LIGAR À TARDE");
  assert.equal(agenda.today, 1);
  assert.equal((await contact(LOJA_A, { result: "cliente_reativado" })).status, 201);
  const after = await (await call(LOJA_A, "GET", undefined, `?view=agenda&companyId=${A}`)).json();
  assert.equal(after.pending.length, 0);
  assert.equal(after.reactivatedMonth, 1);

  const client = await (await call(LOJA_A, "GET", undefined, `?view=client&companyId=${A}&key=81997772222`)).json();
  assert.equal(client.sales.length, 2);
  assert.equal(client.sales[1].items.length, 2);

  // Histórico de 12 meses: a venda de jan/2025 sai na próxima importação.
  assert.equal((await call(LOJA_A, "PUT", { inactiveDays: 180, historyMonths: 6, message: "oi {nome}" })).status, 403);
  assert.equal((await call(ADM, "PUT", { inactiveDays: 10, historyMonths: 6, message: "oi" })).status, 400);
  assert.equal((await call(ADM, "PUT", { inactiveDays: 180, historyMonths: 12, message: "oi {nome}" })).status, 200);
  const purge = await (await call(ADM, "POST", { action: "import", text: FILE })).json();
  assert.equal(purge.preview.purged, 1);
  assert.equal(purge.preview.salesKept, 2);
  const left = await (await call(LOJA_A, "GET", undefined, `?view=clients&companyId=${A}`)).json();
  assert.equal(left.summary.clients, 1);
  assert.equal((await (await call(ADM, "GET")).json()).settings.message, "OI {NOME}");
});
