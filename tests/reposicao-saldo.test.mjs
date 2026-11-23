import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Controle de Reposição (23/11/2026): só ENTRADA/SAÍDA (tipos antigos somam no
// grupo), filtro de RESPONSÁVEL digitado, REPETIDOS (mesma data+valor+tipo),
// categoria própria e financeira alteráveis, SALDO INICIAL por conta de
// responsável e FINALIZAR MÊS (saldo final vira o SALDO MÊS ANTERIOR e trava o mês).

const db = await setupRouteDb(["finance_replacement_entries", "finance_replacement_balances", "expenses", "accounts_payable"]);
const lib = await import("../app/lib/replacement-balance.ts");
const route = await import("../app/api/finance/replacement-control/route.ts");
const bulk = await import("../app/api/finance/replacement-control/bulk/route.ts");
const batch = await import("../app/api/finance/replacement-control/batch/route.ts");
const balance = await import("../app/api/finance/replacement-control/balance/route.ts");
const FIN = { id: "fin", name: "LUANA", permissions: ["finance:manage"] };
const api = "/api/finance/replacement-control";
const json = async (response) => ({ status: response.status, ...(await response.json()) });
const get = (query) => callRoute(route.GET, FIN, "GET", `${api}?${query}`).then(json);
const post = (handler, path, body) => callRoute(handler, FIN, "POST", path, body).then(json);
const entry = (extra) => ({ entryDate: "2026-10-05", reason: "PEÇA", responsibleName: "CECILLIA", kind: "saida", amountCents: 1000, ...extra });

test("regra do saldo: base mais recente (inicial ou fechamento), tipos antigos no grupo e repetidos", () => {
  const entries = [
    { entryDate: "2026-09-10", amountCents: 500, kind: "reposicao", responsibleName: "ANA" }, // antes do saldo inicial: fora
    { entryDate: "2026-10-02", amountCents: 10_000, kind: "reposicao", responsibleName: "ANA" }, // antigo = ENTRADA
    { entryDate: "2026-10-03", amountCents: 2_500, kind: "prejuizo", responsibleName: "ANA" }, // antigo = SAÍDA
    { entryDate: "2026-11-04", amountCents: 1_000, kind: "saida", responsibleName: "ANA" },
  ];
  const initial = [{ kind: "initial", month: "2026-10", responsibleName: "ANA", amountCents: 5_000 }];
  assert.deepEqual(lib.accountBalance(entries, initial, "2026-10", "2026-10"),
    { openingCents: 5_000, inflowCents: 10_000, outflowCents: 2_500, closingCents: 12_500 });
  assert.deepEqual(lib.accountBalance(entries, initial, "2026-11", "2026-11"),
    { openingCents: 12_500, inflowCents: 0, outflowCents: 1_000, closingCents: 11_500 });
  // Fechamento de outubro gravado (ex.: 12.000) manda no SALDO MÊS ANTERIOR de novembro.
  const closed = [...initial, { kind: "closing", month: "2026-10", responsibleName: "ANA", amountCents: 12_000 }];
  assert.equal(lib.accountBalance(entries, closed, "2026-11", "2026-11").openingCents, 12_000);
  // Saldo inicial no mesmo mês em que o fechamento anterior passa a valer: o fechamento vence.
  const both = [{ kind: "closing", month: "2026-10", responsibleName: "ANA", amountCents: 7 }, { kind: "initial", month: "2026-11", responsibleName: "ANA", amountCents: 9 }];
  assert.equal(lib.accountBalance([], both, "2026-11", "2026-11").openingCents, 7);

  const repeated = lib.repeatedEntryIds([
    { id: "a", entryDate: "2026-10-01", amountCents: 100, kind: "saida", responsibleName: "" },
    { id: "b", entryDate: "2026-10-01", amountCents: 100, kind: "prejuizo", responsibleName: "" },
    { id: "c", entryDate: "2026-10-01", amountCents: 100, kind: "entrada", responsibleName: "" },
    { id: "d", entryDate: "2026-10-02", amountCents: 100, kind: "saida", responsibleName: "" },
  ]);
  assert.deepEqual([...repeated].sort(), ["a", "b"]);
});

test("lançamento: só ENTRADA/SAÍDA, categoria própria e financeira, filtro de responsável e de tipo com os antigos", async () => {
  assert.equal((await post(route.POST, api, entry({ kind: "reposicao" }))).error, "SELECIONE SE É ENTRADA OU SAÍDA.");
  const created = await post(route.POST, api, entry({ category: "peças", financeItemId: "item-pecas", sector: "assistencia" }));
  assert.equal(created.status, 201);
  const row = db.sqlite.prepare("SELECT category, finance_item_id, sector FROM finance_replacement_entries WHERE id=?").get(created.id);
  assert.deepEqual([row.category, row.finance_item_id, row.sector], ["PEÇAS", "item-pecas", "assistencia"]);
  await post(route.POST, api, entry({ amountCents: 1000 })); // repetido: mesma data, valor e tipo
  await post(route.POST, api, entry({ kind: "entrada", amountCents: 50_000, responsibleName: "BRUNO" }));
  db.insert("finance_replacement_entries", { id: "antigo", entry_date: "2026-10-07", reason: "PIX", responsible_name: "CECILLIA", kind: "reposicao", amount_cents: 20_000 });

  const all = await get("monthFrom=2026-10&monthTo=2026-10");
  assert.deepEqual(all.responsibles, ["BRUNO", "CECILLIA"]);
  assert.deepEqual(all.categories, ["PEÇAS"]);
  assert.equal(all.rows.filter((r) => r.repeated).length, 2);
  assert.deepEqual(all.balance, { openingCents: 0, inflowCents: 70_000, outflowCents: 2_000, closingCents: 68_000 });

  const cec = await get("monthFrom=2026-10&monthTo=2026-10&responsible=cec");
  assert.equal(cec.rows.length, 3);
  assert.deepEqual(cec.balance, { openingCents: 0, inflowCents: 20_000, outflowCents: 2_000, closingCents: 18_000 });
  const entradas = await get("monthFrom=2026-10&monthTo=2026-10&kind=entrada");
  assert.deepEqual(entradas.rows.map((r) => r.id).includes("antigo"), true, "REPOSIÇÃO antiga aparece em ENTRADA");
  assert.equal(entradas.rows.length, 2);
});

test("saldo inicial, FINALIZAR MÊS trava o mês, saldo final vira o do mês seguinte, REABRIR na ordem", async () => {
  const initial = await post(balance.POST, `${api}/balance`, { action: "initial", responsibleName: "cecillia", month: "2026-10", amountCents: 5_000 });
  assert.equal(initial.name, "CECILLIA");
  // Gravar de novo substitui.
  await post(balance.POST, `${api}/balance`, { action: "initial", responsibleName: "CECILLIA", month: "2026-10", amountCents: 10_000 });
  const oct = await get("monthFrom=2026-10&monthTo=2026-10&responsible=CECILLIA");
  assert.deepEqual(oct.balance, { openingCents: 10_000, inflowCents: 20_000, outflowCents: 2_000, closingCents: 28_000 });

  const closed = await post(balance.POST, `${api}/balance`, { action: "close", month: "2026-10" });
  assert.equal(closed.closed, true);
  assert.equal((await post(balance.POST, `${api}/balance`, { action: "close", month: "2026-10" })).status, 409);
  const saved = db.sqlite.prepare("SELECT responsible_name, amount_cents FROM finance_replacement_balances WHERE kind='closing' ORDER BY responsible_name").all();
  assert.deepEqual(saved.map((r) => [r.responsible_name, r.amount_cents]), [["BRUNO", 50_000], ["CECILLIA", 28_000]]);

  // Mês finalizado: não lança, não edita, não exclui; lote de cadastro pula.
  assert.equal((await post(route.POST, api, entry())).status, 409);
  assert.equal((await post(route.POST, api, { ...entry(), id: "antigo" })).status, 409);
  assert.equal((await callRoute(route.DELETE, FIN, "DELETE", `${api}?id=antigo`)).status, 409);
  const batched = await post(batch.POST, `${api}/batch`, { rows: [entry(), entry({ entryDate: "2026-11-02", amountCents: 3_000 })] });
  assert.equal(batched.created, 1);
  assert.match(batched.skipped[0].reason, /10\/2026 ESTÁ FINALIZADO/);
  // ...mas setor/categoria mudam (não mexem no saldo).
  const updated = await post(bulk.POST, `${api}/bulk`, { action: "update", ids: ["antigo"], fields: { category: "REPOSIÇÃO PIX", financeItemId: "item-x", sector: "logistica" } });
  assert.equal(updated.applied, 1);
  const row = db.sqlite.prepare("SELECT category, finance_item_id, sector FROM finance_replacement_entries WHERE id='antigo'").get();
  assert.deepEqual([row.category, row.finance_item_id, row.sector], ["REPOSIÇÃO PIX", "item-x", "logistica"]);
  const deleted = await post(bulk.POST, `${api}/bulk`, { action: "delete", ids: ["antigo"] });
  assert.equal(deleted.applied, 0);

  // Novembro começa no saldo final gravado de outubro.
  const nov = await get("monthFrom=2026-11&monthTo=2026-11&responsible=CECILLIA");
  assert.deepEqual(nov.balance, { openingCents: 28_000, inflowCents: 0, outflowCents: 3_000, closingCents: 25_000 });
  assert.deepEqual(nov.closedMonths, ["2026-10"]);

  await post(balance.POST, `${api}/balance`, { action: "close", month: "2026-11" });
  assert.match((await post(balance.POST, `${api}/balance`, { action: "reopen", month: "2026-10" })).error, /REABRA PRIMEIRO O MÊS 11\/2026/);
  assert.equal((await post(balance.POST, `${api}/balance`, { action: "reopen", month: "2026-11" })).reopened, true);
  assert.equal((await post(balance.POST, `${api}/balance`, { action: "reopen", month: "2026-10" })).reopened, true);
  assert.equal((await post(route.POST, api, { ...entry(), id: "antigo" })).status, 200, "reaberto: edita de novo");
  assert.equal((await callRoute(balance.POST, { id: "x", permissions: ["stock:view"] }, "POST", `${api}/balance`, { action: "close", month: "2026-10" })).status, 403);
});
