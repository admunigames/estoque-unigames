import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Menu lateral (09/11/2026): ordem alfabética aplicada no boot (Início fixo)
// e campo PESQUISAR MENU.
test("menu: ordena no boot antes dos cards da Início e tem pesquisa", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /renderAll\(\);\s*sortSidebarMenu\(\);\s*buildHomeAccessCards\(\);/);
  assert.match(html, /sortRuns\(sidebar, 'a\.nav-item:not\(#navInicio\), \.nav-group'\)/);
  assert.match(html, /id="sidebarSearch" type="search"/);
  assert.match(html, /\[data-search-hidden\]\{display:none!important\}/);
});
