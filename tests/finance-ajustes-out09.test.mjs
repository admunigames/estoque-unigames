import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Pacote de ajustes do Financeiro de 09/10/2026 (rotas reais sobre SQLite):
// Declaração de Vendas com PLANEJAR O ANO, Recargas → Despesa, Maquinetas,
// Controle de Reposição × extrato e Conciliação Uber.

const db = await setupRouteDb([
  "shared_state", "finance_mall_declarations", "finance_store_revenue",
  "finance_card_machines", "finance_acquirers", "finance_card_fees", "finance_card_machine_events",
  "finance_replacement_entries", "finance_bank_statement_entries",
  "finance_corporate_cards", "finance_card_invoice_entries", "finance_uber_rides",
]);
const plan = await import("../app/api/finance/mall-declarations/plan/route.ts");
const declBatch = await import("../app/api/finance/mall-declarations/batch/route.ts");
const declList = await import("../app/api/finance/mall-declarations/route.ts");
const machines = await import("../app/api/finance/card-machines/route.ts");
const rpBank = await import("../app/api/finance/replacement-control/bank/route.ts");
const uberLib = await import("../app/lib/uber-recon.ts");
const uber = await import("../app/api/finance/corporate-cards/[id]/uber/route.ts");

const ADMIN = { id: "admin", role: "admin" };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };
const json = (response) => response.json();
const post = (handler, path, body, user = ADMIN) => callRoute(handler, user, "POST", path, body);
const get = (handler, path, user = ADMIN) => callRoute(handler, user, "GET", path);
const RIOMAR = "criomar01";
const TACARUNA = "ctacaruna1";

test("Declaração: PLANEJAR O ANO grava o A DECLARAR de cada mês; o lote do mês grava o real na mesma linha", async () => {
  assert.equal((await post(plan.POST, "/api/finance/mall-declarations/plan", {}, NO_FINANCE)).status, 403);
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  const rows = months.map((m, i) => ({ companyId: RIOMAR, companyName: "RIOMAR", competenceMonth: `2027-${m}`, plannedCents: 100_000 + i }));
  rows.push({ companyId: TACARUNA, companyName: "TACARUNA", competenceMonth: "2027-01", plannedCents: 50_000 });
  const saved = await json(await post(plan.POST, "/api/finance/mall-declarations/plan", { year: "2027", rows }));
  assert.equal(saved.saved, 13);
  assert.equal((await post(plan.POST, "/api/finance/mall-declarations/plan", { year: "2027", rows: [{ companyId: RIOMAR, competenceMonth: "2028-01", plannedCents: 1 }] })).status, 400);

  const year = await json(await get(plan.GET, "/api/finance/mall-declarations/plan?year=2027"));
  assert.equal(year.rows.length, 13);
  assert.ok(year.rows.every((row) => Number(row.declaredCents) === 0));

  // Replanejar um mês só atualiza o A DECLARAR (não duplica).
  await post(plan.POST, "/api/finance/mall-declarations/plan", { year: "2027", rows: [{ companyId: RIOMAR, companyName: "RIOMAR", competenceMonth: "2027-01", plannedCents: 120_000 }] });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_mall_declarations WHERE company_id=? AND competence_month='2027-01'").get(RIOMAR).n, 1);

  // Janeiro: o contexto do lote mostra o previsto e o lote grava o real na linha planejada.
  const context = await json(await get(declBatch.GET, "/api/finance/mall-declarations/batch?month=2027-01"));
  assert.equal(context.stores[RIOMAR].plannedCents, 120_000);
  assert.equal(context.stores[RIOMAR].existingDeclaredCents, 0);
  const batchRes = await json(await post(declBatch.POST, "/api/finance/mall-declarations/batch", {
    competenceMonth: "2027-01", rows: [{ companyId: RIOMAR, companyName: "RIOMAR", declaredCents: 118_000 }],
  }));
  assert.equal(batchRes.skipped.length, 0);
  const jan = db.sqlite.prepare("SELECT planned_cents, declared_cents FROM finance_mall_declarations WHERE company_id=? AND competence_month='2027-01'").all(RIOMAR);
  assert.deepEqual(jan.map((row) => ({ ...row })), [{ planned_cents: 120_000, declared_cents: 118_000 }]);
  // Já declarado: o lote não grava de novo.
  const again = await json(await post(declBatch.POST, "/api/finance/mall-declarations/batch", {
    competenceMonth: "2027-01", rows: [{ companyId: RIOMAR, companyName: "RIOMAR", declaredCents: 1 }],
  }));
  assert.deepEqual(again.skipped.map((s) => s.reason), ["JÁ CADASTRADA NO MÊS"]);
  // A lista traz o previsto.
  const list = await json(await get(declList.GET, "/api/finance/mall-declarations?monthFrom=2027-02&monthTo=2027-02"));
  assert.equal(list.rows[0].plannedCents, 100_001);
});

test("Maquinetas: nome, serial e SENHA ADMINISTRATIVA gravados e devolvidos; edição troca a senha", async () => {
  db.sqlite.prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)").run(JSON.stringify([{ id: RIOMAR, name: "RIOMAR" }]));
  db.insert("finance_acquirers", { id: "stone", name: "STONE", status: "active" });
  const created = await post(machines.POST, "/api/finance/card-machines", { acquirerId: "stone", companyId: RIOMAR, model: "RIOMAR CAIXA 1", serial: "SN123", adminPassword: "4321" });
  assert.equal(created.status, 201);
  const { id } = await json(created);
  const list = await json(await get(machines.GET, "/api/finance/card-machines"));
  const machine = list.machines.find((row) => row.id === id);
  assert.deepEqual([machine.model, machine.serial, machine.adminPassword], ["RIOMAR CAIXA 1", "SN123", "4321"]);
  assert.equal((await post(machines.POST, "/api/finance/card-machines", { id, acquirerId: "stone", companyId: RIOMAR, model: "RIOMAR CAIXA 1", serial: "SN123", adminPassword: "9999" })).status, 200);
  assert.equal(db.sqlite.prepare("SELECT admin_password FROM finance_card_machines WHERE id=?").get(id).admin_password, "9999");
});

test("Reposição × extrato: saídas do mês com sugestão, bater, desfazer, sem par e recusas", async () => {
  const entry = (id, extra) => db.insert("finance_bank_statement_entries", { id, import_id: "i", finance_account_id: "acc-1", company_id: RIOMAR, status: "pending", ...extra });
  entry("s1", { entry_date: "2026-10-05", description: "PIX FORNECEDOR CONTROLE", amount_cents: -15000 });
  entry("s2", { entry_date: "2026-10-07", description: "TED PECAS", amount_cents: -8000 });
  entry("e-in", { entry_date: "2026-10-07", description: "DEPOSITO", amount_cents: 9000 });
  const rp = (id, extra) => db.insert("finance_replacement_entries", { id, company_id: RIOMAR, company_name: "RIOMAR", sector: "assistencia", kind: "reposicao", created_by: "seed", ...extra });
  rp("r1", { entry_date: "2026-10-03", product: "CONTROLE PS5", amount_cents: 15000 });
  rp("r2", { entry_date: "2026-10-07", product: "PEÇA A", amount_cents: 5000 });
  rp("r3", { entry_date: "2026-10-08", product: "PEÇA B", amount_cents: 3000 });
  rp("r4", { entry_date: "2026-10-20", product: "SEM PAR", amount_cents: 999 });

  const view = await json(await get(rpBank.GET, "/api/finance/replacement-control/bank?month=2026-10&financeAccountId=acc-1"));
  assert.deepEqual(view.exits.map((e) => e.id), ["s1", "s2"]); // só saídas
  assert.equal(view.exits[0].suggestionId, "r1"); // mesmo valor, 2 dias de diferença
  assert.equal(view.unmatched.length, 4);

  assert.equal((await post(rpBank.POST, "/api/finance/replacement-control/bank", { action: "link", bankEntryId: "e-in", replacementIds: ["r1"] })).status, 400);
  await post(rpBank.POST, "/api/finance/replacement-control/bank", { action: "link", bankEntryId: "s1", replacementIds: ["r1"] });
  await post(rpBank.POST, "/api/finance/replacement-control/bank", { action: "link", bankEntryId: "s2", replacementIds: ["r2", "r3"] });
  const after = await json(await get(rpBank.GET, "/api/finance/replacement-control/bank?month=2026-10"));
  assert.deepEqual(after.exits.map((e) => [e.id, e.linked.length, e.linkedCents]), [["s1", 1, 15000], ["s2", 2, 8000]]);
  assert.deepEqual(after.unmatched.map((r) => r.id), ["r4"]);
  // Já ligado a outra saída: 409; desfazer libera.
  assert.equal((await post(rpBank.POST, "/api/finance/replacement-control/bank", { action: "link", bankEntryId: "s1", replacementIds: ["r2"] })).status, 409);
  await post(rpBank.POST, "/api/finance/replacement-control/bank", { action: "unlink", replacementIds: ["r2", "r3"] });
  assert.equal((await json(await get(rpBank.GET, "/api/finance/replacement-control/bank?month=2026-10"))).unmatched.length, 3);
  assert.equal((await post(rpBank.POST, "/api/finance/replacement-control/bank", { action: "unlink", replacementIds: ["nao-existe"] })).status, 404);
  assert.equal((await get(rpBank.GET, "/api/finance/replacement-control/bank?month=2026-10", NO_FINANCE)).status, 403);
});

test("Uber (puro): mesmo valor, até 1 dia, menor diferença primeiro; cada cobrança com uma corrida", () => {
  const pairs = uberLib.matchUberRides(
    [{ id: "r1", rideDate: "2026-10-05", amountCents: 2350 }, { id: "r2", rideDate: "2026-10-05", amountCents: 2350 }, { id: "r3", rideDate: "2026-10-07", amountCents: 1000 }],
    [{ id: "c1", entryDate: "2026-10-06", amountCents: 2350 }, { id: "c2", entryDate: "2026-10-05", amountCents: 2350 }, { id: "c3", entryDate: "2026-10-09", amountCents: 1000 }],
  );
  assert.deepEqual(pairs, [{ rideId: "r1", chargeId: "c2" }, { rideId: "r2", chargeId: "c1" }]); // r3: 2 dias → sem par
  assert.equal(uberLib.isUberMerchant("UBER *TRIP HELP.UBER.COM"), true);
  assert.equal(uberLib.isUberMerchant("SUPERMERCADO TUBERCULO"), false);
});

test("Uber (rota): importar a planilha casa com a fatura; repetida pulada; conciliar de novo; bater/desfazer; excluir", async () => {
  db.insert("finance_corporate_cards", { id: "card-1", name: "CARTÃO DIRETORIA", company_id: RIOMAR, company_name: "RIOMAR", status: "active", created_by: "seed" });
  const charge = (id, extra) => db.insert("finance_card_invoice_entries", { id, import_id: "f1", card_id: "card-1", company_id: RIOMAR, ...extra });
  charge("c1", { entry_date: "2026-10-05", merchant: "UBER *TRIP", amount_cents: 2350 });
  charge("c2", { entry_date: "2026-10-12", merchant: "UBER DO BRASIL", amount_cents: 4100 });
  charge("c-outro", { entry_date: "2026-10-05", merchant: "POSTO SHELL", amount_cents: 2350 });
  const path = "/api/finance/corporate-cards/card-1/uber";
  const call = (method, body, user = ADMIN) => callRoute(method === "GET" ? uber.GET : uber.POST, user, method, method === "GET" ? `${path}?month=2026-10` : path, body, { id: "card-1" });

  const imported = await json(await call("POST", { action: "import", sourceName: "corridas.xlsx", rows: [
    { rideDate: "2026-10-04", amountCents: 2350, passenger: "ANA", reason: "BANCO" },
    { rideDate: "2026-10-20", amountCents: 1800, passenger: "JOÃO", reason: "FORNECEDOR" },
    { rideDate: "2026-10-04", amountCents: 2350, passenger: "ANA", reason: "REPETIDA" },
    { rideDate: "xx", amountCents: 1 },
  ] }));
  assert.equal(imported.inserted, 2);
  assert.equal(imported.matched, 1);
  assert.deepEqual(imported.skipped.map((s) => s.reason), ["JÁ IMPORTADA", "DATA INVÁLIDA"]);

  let view = await json(await call("GET"));
  assert.equal(view.rides.find((r) => r.passenger === "ANA").charge.id, "c1");
  assert.deepEqual(view.freeCharges.map((c) => c.id), ["c2"]); // posto não é Uber
  assert.deepEqual(view.totals, { ridesCents: 4150, chargesCents: 6450 });

  const joao = view.rides.find((r) => r.passenger === "JOÃO");
  assert.equal((await call("POST", { action: "link", rideId: joao.id, entryId: "c1" })).status, 409);
  await call("POST", { action: "link", rideId: joao.id, entryId: "c2" });
  view = await json(await call("GET"));
  assert.equal(view.freeCharges.length, 0);
  await call("POST", { action: "unlink", rideId: joao.id });
  assert.equal((await json(await call("GET"))).freeCharges.length, 1);
  // Corrida nova de mesmo valor da cobrança livre: conciliar de novo casa.
  db.insert("finance_uber_rides", { id: "r-novo", card_id: "card-1", ride_date: "2026-10-12", amount_cents: 4100, passenger: "BIA" });
  assert.equal((await json(await call("POST", { action: "automatch", month: "2026-10" }))).matched, 1);
  assert.equal((await call("POST", { action: "delete", ids: ["r-novo", "nao-existe"] })).status, 404);
  await call("POST", { action: "delete", ids: ["r-novo"] });
  assert.equal((await json(await call("GET"))).rides.length, 2);
  assert.equal((await call("GET", undefined, NO_FINANCE)).status, 403);
});
