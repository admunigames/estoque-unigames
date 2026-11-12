import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Compras (12/11/2026): VENDA do texto da divisão = "Preço" da Unigames no
// Cadastro de Produtos (P.A é digitado à mão).
const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");

function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(name);
}

const names = ["normalizeHeader", "parseNumeroBR", "isFooterRow", "cleanCodigo", "formatCentsBRL", "parseCatalogRows", "mapCatalogItemsFromParsedMap", "comprasSalePriceCents", "comprasDivisionSuggestion"];
const make = new Function("ctx", `let {productCatalogItems, comprasCurrentOrderItems} = ctx;\n${names.map(extract).join("\n")}\nreturn {${names.join(",")}};`);

test("relatório de cadastro: lê a coluna Preço e o texto do pedido sai com a VENDA da Unigames", () => {
  const rows = [
    ["Relatório de Produto"],
    ["Código", "Cód Fornecedor", "Cód Barras", "Gtin", "Produto", "Medida", "Volume (m³)", "Pr Comp", "Custo", "Preço"],
    ["0205", ",,", "78900000204", "", "007 BLOOD STONE", "UN", "0", "0,00", "4,50", "1.012,00"],
    ["0011", ",,", "", "", "CABO HDMI", "UN", "0", "0,00", "2,25", ""],
  ];
  const { parseCatalogRows, mapCatalogItemsFromParsedMap } = make({ productCatalogItems: [], comprasCurrentOrderItems: [] });
  assert.deepEqual(mapCatalogItemsFromParsedMap(parseCatalogRows(rows)), [
    { code: "0205", name: "007 BLOOD STONE", salePriceCents: 101200 },
    { code: "0011", name: "CABO HDMI", salePriceCents: null },
  ]);

  const fns = make({
    productCatalogItems: [
      { name: "007 BLOOD STONE", codeUnigames: "0205", codePa: "", salePriceCents: 1200 },
      { name: "CONTROLE PS5", codeUnigames: "9", codePa: "PA9", salePriceCents: 49990 },
      { name: "SÓ P.A", codeUnigames: "", codePa: "PA1", salePriceCents: 500 },
    ],
    comprasCurrentOrderItems: [
      { quantity: 2, productCode: "0205", productName: "007 BLOOD STONE", unitPriceCents: 450 },
      { quantity: 1, productCode: "X", productName: "controle ps5", unitPriceCents: 0 },
      { quantity: 3, productCode: "PA1", productName: "SÓ P.A", unitPriceCents: 100 },
    ],
  });
  const text = fns.comprasDivisionSuggestion({ supplierName: "FORN", companyName: "RECIFE" }).replace(/ /g, " ");
  assert.match(text, /2 - 007 BLOOD STONE\nCUSTO: R\$ 4,50 - VENDA: R\$ 12,00/);
  assert.match(text, /1 - controle ps5\nCUSTO: R\$ - - VENDA: R\$ 499,90/);
  assert.match(text, /3 - SÓ P\.A\nCUSTO: R\$ 1,00 - VENDA: R\$ -/);
});
