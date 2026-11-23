import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// RMA > CRÉDITOS: filtro SITUAÇÃO (13/11/2026), GERAR IMAGEM dos disponíveis
// e crédito por empresa — um cadastro gera um crédito por empresa (23/11/2026).

const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
const db = await setupRouteDb(["shared_state", "rma_cases", "rma_credits", "rma_disposals", "rma_suppliers", "rma_attachments", "rma_options"]);
const cadastros = await import("../app/api/assistencia/rma/cadastros/route.ts");
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "ctaca", name: "TACARUNA" }, { id: "crio", name: "RIOMAR" }]) });
const FIN = { id: "fin", name: "FIN", permissions: ["rma:view", "rma:finance"] };
const call = (method, body) => callRoute(cadastros[method], FIN, method, "/api/assistencia/rma/cadastros", body);

test("crédito novo dividido por empresa: um registro por empresa, tudo ou nada", async () => {
  const base = { entity: "credit", supplier: "duex", status: "DISPONÍVEL", generatedDate: "2026-11-20" };
  assert.equal((await call("POST", { ...base, splits: [{ companyId: "ctaca", creditValue: "100" }, { companyId: "ctaca", creditValue: "50" }] })).status, 400);
  assert.equal((await call("POST", { ...base, splits: [{ companyId: "ctaca", creditValue: "100" }, { companyId: "", creditValue: "50" }] })).status, 400);
  assert.equal((await call("POST", { ...base, splits: [{ companyId: "ctaca", creditValue: "100" }, { companyId: "crio", creditValue: "0" }] })).status, 400);
  assert.equal((await call("GET")).status, 200);
  assert.equal((await (await call("GET")).json()).credits.length, 0, "nada gravado quando uma linha é inválida");

  const created = await call("POST", { ...base, splits: [{ companyId: "ctaca", creditValue: "1.200,50" }, { companyId: "crio", creditValue: "300" }] });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).ids.length, 2);
  const credits = (await (await call("GET")).json()).credits;
  assert.deepEqual(credits.map((c) => [c.supplier, c.companyName, c.creditCents]).sort(), [["DUEX", "RIOMAR", 30000], ["DUEX", "TACARUNA", 120050]]);

  // Edição troca a empresa; empresa desconhecida é recusada.
  const id = credits.find((c) => c.companyName === "RIOMAR").id;
  assert.equal((await call("PATCH", { entity: "credit", id, supplier: "DUEX", creditValue: "300", companyId: "nao-existe" })).status, 400);
  assert.equal((await call("PATCH", { entity: "credit", id, supplier: "DUEX", creditValue: "300", companyId: "ctaca" })).status, 200);
  assert.equal((await (await call("GET")).json()).credits.filter((c) => c.companyId === "ctaca").length, 2);
});

test("aba CRÉDITOS tem o filtro SITUAÇÃO com as 3 opções, TODOS como padrão", () => {
  const select = html.match(/<select id="rmaCreditSituation">([\s\S]*?)<\/select>/);
  assert.ok(select, "select rmaCreditSituation");
  assert.match(select[1], /^<option value="">TODOS<\/option><option value="disponiveis">DISPONÍVEIS<\/option><option value="indisponiveis">INDISPONÍVEIS<\/option>$/);
  assert.match(html, /el\('rmaCreditSituation'\)\.addEventListener\('change', renderRmaCredits\)/);
  assert.match(html, /rmaExtra\.credits\.filter\(item => rmaCreditAvailable\(item\) === \(situation === 'disponiveis'\)\)/);
});

test("NOVO CRÉDITO: linhas EMPRESA + VALOR e saldo do fornecedor no fim", () => {
  assert.match(html, /<th>Fornecedor<\/th><th>Empresa<\/th>/);
  assert.match(html, /CRÉDITO POR EMPRESA \*/);
  assert.match(html, /id="btnRmaCreditSplitAdd">\+ EMPRESA<\/button>/);
  assert.match(html, /SALDO TOTAL DISPONÍVEL DO FORNECEDOR/);
  assert.match(html, /rmaCadastros\('POST', \{\.\.\.body, usedValue: 0, splits\}\)/);
});

test("GERAR IMAGEM fica na barra da aba, usa só os disponíveis e soma por loja", () => {
  const view = html.match(/<div id="rmaCreditsView" hidden>([\s\S]*?)<div class="table-panel/)[1];
  assert.match(view, /<div class="dre-toolbar-actions"><button[^>]*id="btnRmaCreditsImage">GERAR IMAGEM<\/button>/);
  assert.match(html, /const list = rmaExtra\.credits\.filter\(rmaCreditAvailable\);\s*if\(!list\.length\)/);
  assert.match(html, /title: 'CRÉDITOS RMA DISPONÍVEIS'/);
  assert.match(html, /byStore\.set\(item\.companyName \|\| 'SEM LOJA'/);
  assert.match(html, /'TOTAL '\+formatCentsBRL\(items\.reduce/);
  assert.match(html, /shareCanvasImage\(await rmaBuildCreditsImage\(list\)/);
});
