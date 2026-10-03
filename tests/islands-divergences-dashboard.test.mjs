import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

// A lógica da ilha importa app/lib/divergences sem extensão (padrão do
// projeto para o bundler); aqui o Node resolve tentando ".ts".
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.startsWith("file:")) {
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

const logic = await import("../islands/divergences-dashboard/logic.ts");

const SAMPLE = {
  allStores: true,
  totals: { requests: 7, items: 12, totalAbs: 1530, overdue: 2 },
  requestsByStatus: { aberto: 3, verificacao: 2, finalizado: 2 },
  itemsByStatus: { nao_visto: 4, em_verificacao: 3, verificacao_loja: 1, concluido: 3, inventario: 1 },
  byStore: [
    { companyId: "c1", companyName: "LOJA RIOMAR", requests: 4, items: 8, missing: 10, surplus: 2, pending: 5 },
    { companyId: "c2", companyName: "LOJA GUARARAPES", requests: 3, items: 4, missing: 0, surplus: 4, pending: 0 },
  ],
  topProducts: [
    { productCode: "", productName: "CONTROLE PS5", occurrences: 1, totalAbs: 9, storeCount: 1, multiStore: false,
      stores: [{ companyName: "LOJA RIOMAR", divergence: -9, items: 1 }] },
    { productCode: "123", productName: "CABO HDMI", occurrences: 3, totalAbs: 5, storeCount: 2, multiStore: true,
      stores: [{ companyName: "LOJA GUARARAPES", divergence: 2, items: 1 }, { companyName: "LOJA RIOMAR", divergence: -3, items: 2 }] },
    { productCode: "", productName: "BATERIA", occurrences: 3, totalAbs: 5, storeCount: 2, multiStore: true,
      stores: [{ companyName: "LOJA RIOMAR", divergence: 0, items: 1 }] },
  ],
};

test("ilha Divergências: formatação de números e larguras das barras", () => {
  assert.equal(logic.toCount("7"), 7);
  assert.equal(logic.toCount(undefined), 0);
  assert.equal(logic.toCount("abc"), 0);
  assert.equal(logic.formatCount(1530), "1.530");
  assert.equal(logic.formatCount(null), "0");
  assert.equal(logic.barWidth(1, 3), "33.33%");
  assert.equal(logic.barWidth(3, 3), "100.00%");
  assert.equal(logic.barWidth(0, 3), "0.00%");
  // Sem total ou com valor inválido/fora da escala: nunca NaN nem >100%.
  assert.equal(logic.barWidth(5, 0), "0.00%");
  assert.equal(logic.barWidth(9, 3), "100.00%");
  assert.equal(logic.barWidth(-2, 3), "0.00%");
});

test("ilha Divergências: cards de métrica com textos e filtros da aba PEDIDOS", () => {
  const metrics = logic.buildMetrics(SAMPLE);
  assert.deepEqual(metrics.map((metric) => [metric.label, metric.value, metric.alert]), [
    ["PEDIDOS EM ABERTO", 3, false],
    ["PEDIDOS EM VERIFICAÇÃO", 2, false],
    ["PEDIDOS FINALIZADOS", 2, false],
    ["NÃO VISTOS HÁ MAIS DE 14 DIAS", 2, true],
  ]);
  assert.deepEqual(metrics.map((metric) => metric.filter), [
    { status: "aberto", itemStatus: "" },
    { status: "verificacao", itemStatus: "" },
    { status: "finalizado", itemStatus: "" },
    { status: "", itemStatus: "nao_visto" },
  ]);
  // Resposta vazia/ausente: tudo zero, sem alerta.
  const empty = logic.buildMetrics(null);
  assert.deepEqual(empty.map((metric) => metric.value), [0, 0, 0, 0]);
  assert.equal(empty[3].alert, false);
});

test("ilha Divergências: ITENS POR STATUS na ordem fixa, com fatias e barras", () => {
  const chart = logic.buildItemsChart(SAMPLE);
  assert.equal(chart.total, 12);
  assert.equal(chart.summary, "12 ITEM(NS) · 1.530 UN. DE DIVERGÊNCIA");
  assert.deepEqual(chart.rows.map((row) => row.status), [
    "nao_visto", "em_verificacao", "verificacao_loja", "concluido", "inventario",
  ]);
  assert.deepEqual(chart.rows.map((row) => row.label), [
    "NÃO VISTO", "EM VERIFICAÇÃO", "VERIFICAÇÃO DA LOJA", "CONCLUÍDO", "ANOTADO PARA INVENTÁRIO",
  ]);
  // Fatia = parte do total de itens; barra = parte do maior status (4).
  assert.deepEqual(chart.rows.map((row) => row.share), ["33.33%", "25.00%", "8.33%", "25.00%", "8.33%"]);
  assert.deepEqual(chart.rows.map((row) => row.width), ["100.00%", "75.00%", "25.00%", "75.00%", "25.00%"]);
  const none = logic.buildItemsChart({});
  assert.equal(none.total, 0);
  assert.equal(none.summary, "0 ITEM(NS) · 0 UN. DE DIVERGÊNCIA");
  assert.ok(none.rows.every((row) => row.share === "0.00%" && row.width === "0.00%"));
});

test("ilha Divergências: DIVERGÊNCIAS POR LOJA na mesma escala dos dois lados", () => {
  const rows = logic.buildStoreChart(SAMPLE);
  assert.deepEqual(rows.map((row) => [row.name, row.detail, row.missing, row.surplus, row.missingWidth, row.surplusWidth]), [
    ["LOJA RIOMAR", "8 ITEM(NS) · 5 PENDENTE(S)", 10, 2, "100.00%", "20.00%"],
    ["LOJA GUARARAPES", "4 ITEM(NS) · 0 PENDENTE(S)", 0, 4, "0.00%", "40.00%"],
  ]);
  // Chaves únicas mesmo com loja repetida/sem id.
  const keys = logic.buildStoreChart({ byStore: [{ companyName: "X" }, { companyName: "X" }, {}] }).map((row) => row.key);
  assert.equal(new Set(keys).size, 3);
  assert.equal(logic.buildStoreChart({ byStore: [{}] })[0].name, "—");
  assert.deepEqual(logic.buildStoreChart({ byStore: "inválido" }), []);
});

test("ilha Divergências: produtos mais divergentes ordenados como na rota", () => {
  const products = logic.buildTopProducts(SAMPLE);
  // Mais lojas → mais ocorrências → mais unidades → nome (pt-BR).
  assert.deepEqual(products.map((product) => [product.rank, product.name]), [
    ["1º", "BATERIA"],
    ["2º", "CABO HDMI"],
    ["3º", "CONTROLE PS5"],
  ]);
  const cabo = products[1];
  assert.equal(cabo.detail, "CÓD. 123 · 3 OCORRÊNCIA(S) · 5 UN. DE DIVERGÊNCIA");
  assert.equal(cabo.multiStore, true);
  assert.deepEqual(cabo.side, { key: "side", label: "EM 2 LOJAS", tone: "alert" });
  assert.deepEqual(cabo.stores.map((pill) => [pill.label, pill.tone]), [
    ["LOJA GUARARAPES: 02 A MAIS FISICAMENTE", "progress"],
    ["LOJA RIOMAR: 03 A MENOS FISICAMENTE", "alert"],
  ]);
  assert.equal(products[0].stores[0].label, "LOJA RIOMAR: SEM DIVERGÊNCIA");
  assert.equal(products[0].stores[0].tone, "");
  const controle = products[2];
  assert.equal(controle.detail, "1 OCORRÊNCIA(S) · 9 UN. DE DIVERGÊNCIA");
  assert.deepEqual(controle.side, { key: "side", label: "1 LOJA", tone: "" });
  // Não altera a lista recebida.
  assert.equal(SAMPLE.topProducts[0].productName, "CONTROLE PS5");
  assert.deepEqual(logic.buildTopProducts({}), []);
});

test("ilha Divergências: código-fonte sem HTML cru", async () => {
  const dir = new URL("../islands/", import.meta.url);
  const files = (await readdir(dir, { recursive: true })).filter((file) => /\.tsx?$/.test(file));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML/, file);
  }
});

test("build das ilhas: manifest, vendor único do React e registro da ilha", async () => {
  const clientDir = new URL("../dist/client/", import.meta.url);
  const manifestUrl = new URL("islands/manifest.json", clientDir);
  assert.ok(existsSync(manifestUrl), "dist/client/islands/manifest.json não existe (rode pnpm build)");
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.match(manifest.vendor, /^\/islands\/vendor-react-[0-9a-z]+\.js$/);
  assert.match(manifest.islands["divergences-dashboard"], /^\/islands\/divergences-dashboard-[0-9a-z]+\.js$/);

  const vendorUrl = new URL(manifest.vendor.slice(1), clientDir);
  const islandUrl = new URL(manifest.islands["divergences-dashboard"].slice(1), clientDir);
  assert.ok(existsSync(vendorUrl), `${manifest.vendor} não existe`);
  assert.ok(existsSync(islandUrl), `${manifest.islands["divergences-dashboard"]} não existe`);
  const [vendor, island] = await Promise.all([readFile(vendorUrl, "utf8"), readFile(islandUrl, "utf8")]);

  // A ilha importa o vendor (caminho relativo, mesma pasta)...
  const vendorFile = manifest.vendor.split("/").pop();
  assert.match(island, new RegExp(`from\\s*["']\\./${vendorFile.replace(".", "\\.")}["']`));
  // ...e o código do React só existe no vendor.
  for (const marker of [
    "react.transitional.element",
    "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
    "createRoot",
  ]) {
    assert.ok(vendor.includes(marker), `vendor sem ${marker}`);
    if (marker !== "createRoot") assert.ok(!island.includes(marker), `a ilha embutiu ${marker}`);
  }
  assert.doesNotMatch(island, /from\s*["'](react|react-dom)/);
  // Registro público da ilha (contrato mount/update/unmount).
  assert.match(island, /UnigamesIslands/);
  assert.match(island, /divergencesDashboard/);
  for (const method of ["mount", "update", "unmount"]) assert.match(island, new RegExp(`\\b${method}\\b`));
  // Todas as ilhas listadas existem e importam o mesmo vendor.
  for (const [name, src] of Object.entries(manifest.islands)) {
    const code = await readFile(new URL(src.slice(1), clientDir), "utf8");
    assert.ok(code.includes(vendorFile), `${name} não importa ${vendorFile}`);
    assert.ok(!code.includes("react.transitional.element"), `${name} embutiu o React`);
  }
});
