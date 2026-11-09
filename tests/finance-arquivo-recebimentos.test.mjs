import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// ARQUIVO DO BANCO no Fluxo de Caixa (09/11/2026): o front acha as colunas
// pelo nome (modelo da Stone aqui) e a rota grava as parcelas, soma um
// recebível por conta + loja + adquirente + dia, marca recebido o dia todo
// pago e substitui a estimativa pelas vendas (card-forecast).

const db = await setupRouteDb([
  "shared_state", "accounts_receivable", "finance_accounts", "finance_acquirers", "finance_card_machines",
  "finance_card_machine_events", "finance_card_receipt_lines", "finance_card_sales",
]);
const { todayInTimezone, addDays } = await import("../app/lib/finance-status.ts");
const route = await import("../app/api/finance/cash-flow/receipt-file/route.ts");
const estimate = await import("../app/api/finance/cash-flow/import-receivables/route.ts");

const FINANCE = { id: "fin", permissions: ["finance:manage"] };
const STORE = "criomar01";
const today = todayInTimezone();
const d = (offset) => addDays(today, offset);
const br = (iso) => iso.split("-").reverse().join("/");
const many = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;

db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: STORE, name: "RIOMAR" }]) });
db.insert("finance_accounts", { id: "acc", company_id: "", company_name: "", name: "STONE PJ", active: 1 });
db.insert("finance_acquirers", { id: "acq-stone", name: "STONE", debit_days: 1, credit_days: 30, anticipated: 0 });
db.insert("finance_card_machines", { id: "m1", acquirer_id: "acq-stone", acquirer_name: "STONE", establishment_code: "153362559", company_id: STORE, company_name: "RIOMAR" });
db.insert("finance_card_sales", { id: "s1", import_id: "imp", company_id: STORE, acquirer_id: "acq-stone", acquirer_name: "STONE", modality: "debit", installments: 1, gross_cents: 10_000, expected_fee_cents: 200, net_cents: 9_800, sale_date: today });

function frontParser(html) {
  const grab = (marker) => {
    const start = html.indexOf(marker);
    assert.notEqual(start, -1, marker);
    let depth = 0, end = html.indexOf("{", start);
    for (; end < html.length; end++) {
      if (html[end] === "{") depth++;
      if (html[end] === "}" && --depth === 0) break;
    }
    return html.slice(start, end + 1);
  };
  const source = ["function normHeader(", "function findColumn(", "function parseMoneyToCents(", "function parseDateISO(", "const CF_FILE_COLUMNS =", "function cfMapFileColumns(", "function cfParseReceiptFile("].map(grab).join(";\n");
  return new Function(`${source}; return cfParseReceiptFile;`)();
}

const header = "DOCUMENTO;STONECODE;CATEGORIA;DATA DA VENDA;DATA DE VENCIMENTO;DATA DE VENCIMENTO ORIGINAL;BANDEIRA;PRODUTO;STONE ID;QTD DE PARCELAS;Nº DA PARCELA;VALOR BRUTO;VALOR LÍQUIDO;DESCONTO DE MDR;DESCONTO DE ANTECIPAÇÃO;DESCONTO UNIFICADO;ÚLTIMO STATUS;DATA DO ÚLTIMO STATUS;ENTRADAS BRUTAS;SAÍDAS BRUTAS";
const stoneFile = (status) => [
  header,
  `59.601.284/0001-14;153362559;Venda;05/03/2026 11:17:52;${br(d(1))};${br(d(20))};Visa;Credito;164;10;9;200,000000;194,340000;-5,66;0;0;${status};x;200;0`,
  `59.601.284/0001-14;153362559;Venda;01/10/2026 20:41:19;${br(d(1))};${br(d(1))};Visa;Credito;374;12;2;157,410000;153,175671;-4,23;0;0;${status};x;157;0`,
  `59.601.284/0001-14;153362559;Cancelamento;05/11/2026 18:34:18;${br(d(1))};${br(d(1))};Visa;Credito;409;6;6;-99,990000;-97,650234;2,33;0;0;${status};x;0;-99`,
  `59.601.284/0001-14;153362559;Venda;31/10/2026 21:08:57;${br(d(-2))};${br(d(-2))};MasterCard;Debito;405;1;1;280,000000;274,036000;-5,96;0;0;Pago;x;280;0`,
  `59.601.284/0001-14;999999999;Venda;31/10/2026 21:08:57;${br(d(-2))};${br(d(-2))};Elo;Debito;777;1;1;50,000000;49,000000;-1;0;0;Pago;x;50;0`,
].map((line) => line.split(";"));

const post = async (rows, extra = {}) => {
  const response = await callRoute(route.POST, FINANCE, "POST", "/api/finance/cash-flow/receipt-file", { financeAccountId: "acc", acquirerId: "acq-stone", sourceName: "recebimentos.csv", rows, ...extra });
  return { status: response.status, body: await response.json() };
};

test("arquivo da Stone: colunas pelo nome, prévia, gravação por dia, pago = recebido, substitui a estimativa", async () => {
  const parse = frontParser(await readFile(new URL("../public/estoque.html", import.meta.url), "utf8"));
  const parsed = parse(stoneFile("Aberto"));
  assert.equal(parsed.rows.length, 5);
  const first = parsed.rows[0];
  assert.deepEqual(
    [first.dueDate, first.saleDate, first.installments, first.installmentNo, first.grossCents, first.netCents, first.saleRef, first.establishment, first.status],
    [d(1), "2026-03-05", 10, 9, 20_000, 19_434, "164", "153362559", "Aberto"],
    "vencimento (não o ORIGINAL), parcela 9/10, bruto e líquido",
  );
  assert.equal(parsed.rows[2].netCents, -9_765, "cancelamento negativo");

  // Estimativa pelas vendas para o mesmo dia (débito D+1).
  const before = await (await callRoute(estimate.POST, FINANCE, "POST", "/api/finance/cash-flow/import-receivables", { to: d(10), financeAccountId: "acc" })).json();
  assert.equal(before.created, 1);

  const preview = await post(parsed.rows, { dryRun: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.rejected, [{ line: 6, reason: "LOJA NÃO IDENTIFICADA (ESCOLHA A LOJA)" }]);
  assert.deepEqual(
    preview.body.groups.map((g) => [g.date, g.count, g.netCents, g.action, g.replacesCents]),
    [[d(-2), 1, 27_404, "received", 0], [d(1), 3, 19_434 + 15_318 - 9_765, "new", 9_800]],
  );
  assert.equal((await many("SELECT id FROM finance_card_receipt_lines")).length, 0, "prévia não grava");
  assert.deepEqual([preview.body.summary.cancelLines, preview.body.summary.cancelCents], [1, -9_765], "cancelamentos em destaque na prévia");

  const saved = await post(parsed.rows);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const receivables = async () => many("SELECT expected_date AS date, expected_amount_cents AS cents, received_amount_cents AS received, canceled, idempotency_key AS k FROM accounts_receivable ORDER BY expected_date, k");
  assert.deepEqual(
    (await receivables()).map((r) => [r.date, r.cents, r.received, r.canceled, r.k.split(":")[0]]),
    [[d(-2), 27_404, 27_404, 0, "card-file"], [d(1), 24_987, null, 0, "card-file"], [d(1), 9_800, null, 1, "card-forecast"]],
  );

  // Dia com parte paga e parte em aberto: dois recebíveis (só o aberto vai para a projeção).
  const mixed = parse(stoneFile("Agendado")).rows.map((row) => (row.saleRef === "374" ? { ...row, status: "Pago" } : row));
  const split = await post(mixed, { dryRun: true });
  assert.deepEqual(
    split.body.groups.filter((g) => g.date === d(1)).map((g) => [g.netCents, g.paid, g.action]),
    [[19_434 - 9_765, false, "update"], [15_318, true, "received"]],
  );

  // Estimar de novo não volta a lançar o dia que veio do arquivo.
  const again = await (await callRoute(estimate.GET, FINANCE, "GET", `/api/finance/cash-flow/import-receivables?to=${d(10)}`)).json();
  assert.equal(again.lines[0].action, "file");

  // Reimportar com o dia pago: atualiza as mesmas parcelas e marca recebido.
  const paid = await post(parse(stoneFile("Pago")).rows, { companyId: STORE });
  assert.equal(paid.body.summary.updatedLines, 4);
  assert.equal(paid.body.summary.newLines, 1, "a linha sem maquineta entra pela loja escolhida");
  assert.equal((await many("SELECT id FROM finance_card_receipt_lines")).length, 5);
  assert.deepEqual(
    (await receivables()).filter((r) => r.k.startsWith("card-file")).map((r) => [r.date, r.cents, r.received, r.k.endsWith(":PAGO")]),
    [[d(-2), 27_404 + 4_900, 27_404 + 4_900, true], [d(1), 24_987, 24_987, true]],
    "dia pago soma a nova parcela; o recebível em aberto do dia que ficou todo pago sai",
  );

  const list = await (await callRoute(route.GET, FINANCE, "GET", `/api/finance/cash-flow/receipt-file?month=${d(1).slice(0, 7)}&accountId=acc`)).json();
  const sale = list.lines.find((row) => row.saleRef === "164");
  assert.deepEqual([sale.installmentNo, sale.installments, sale.grossCents, sale.feeCents, sale.brand, sale.statusText, sale.paid], [9, 10, 20_000, 566, "VISA", "PAGO", 1]);
});

test("arquivo sem conta/adquirente é recusado", async () => {
  const response = await callRoute(route.POST, FINANCE, "POST", "/api/finance/cash-flow/receipt-file", { acquirerId: "acq-stone", rows: [{ dueDate: today, netCents: 100 }] });
  assert.equal(response.status, 400);
  const noAcquirer = await callRoute(route.POST, FINANCE, "POST", "/api/finance/cash-flow/receipt-file", { financeAccountId: "acc", rows: [{ dueDate: today, netCents: 100 }] });
  assert.equal(noAcquirer.status, 400);
});
