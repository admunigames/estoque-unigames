import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// RMA > CRÉDITOS (13/11/2026): filtro SITUAÇÃO (TODOS/DISPONÍVEIS/INDISPONÍVEIS)
// só no navegador e GERAR IMAGEM sempre com os disponíveis.

const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");

test("aba CRÉDITOS tem o filtro SITUAÇÃO com as 3 opções, TODOS como padrão", () => {
  const select = html.match(/<select id="rmaCreditSituation">([\s\S]*?)<\/select>/);
  assert.ok(select, "select rmaCreditSituation");
  assert.match(select[1], /^<option value="">TODOS<\/option><option value="disponiveis">DISPONÍVEIS<\/option><option value="indisponiveis">INDISPONÍVEIS<\/option>$/);
  assert.match(html, /el\('rmaCreditSituation'\)\.addEventListener\('change', renderRmaCredits\)/);
  assert.match(html, /rmaExtra\.credits\.filter\(item => rmaCreditAvailable\(item\) === \(situation === 'disponiveis'\)\)/);
});

test("GERAR IMAGEM fica na barra da aba e usa só os disponíveis", () => {
  const view = html.match(/<div id="rmaCreditsView" hidden>([\s\S]*?)<div class="table-panel/)[1];
  assert.match(view, /<div class="dre-toolbar-actions"><button[^>]*id="btnRmaCreditsImage">GERAR IMAGEM<\/button>/);
  assert.match(html, /const list = rmaExtra\.credits\.filter\(rmaCreditAvailable\);\s*if\(!list\.length\)/);
  assert.match(html, /title: 'CRÉDITOS RMA DISPONÍVEIS'/);
  assert.match(html, /shareCanvasImage\(await rmaBuildCreditsImage\(list\)/);
});
