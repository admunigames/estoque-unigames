import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// INVESTIMENTOS dentro de uma conta já cadastrada (04/11/2026): aplicações e
// resgates; saldo investido até a data alimenta o INVESTIDO do Caixa Semanal.

const db = await setupRouteDb(["finance_accounts", "finance_account_investments"]);
const route = await import("../app/api/finance/accounts/investments/route.ts");
const ADMIN = { id: "admin", role: "admin" };
db.insert("finance_accounts", { id: "itau", name: "ITAÚ GUARARAPES", type: "checking", person_type: "pj", active: 1, created_by: "s" });
const post = (body) => callRoute(route.POST, ADMIN, "POST", "/api/finance/accounts/investments", body);
const get = async (query) => (await callRoute(route.GET, ADMIN, "GET", `/api/finance/accounts/investments?${query}`)).json();

test("aplicação, resgate, saldo por data e validações", async () => {
  assert.equal((await post({ accountId: "itau", kind: "x", entryDate: "2030-11-01", amountCents: 1 })).status, 400);
  assert.equal((await post({ accountId: "nada", kind: "aplicacao", entryDate: "2030-11-01", amountCents: 1 })).status, 404);
  assert.equal((await post({ accountId: "itau", kind: "aplicacao", entryDate: "2030-11-01", amountCents: 100_000, description: "cdb" })).status, 201);
  assert.equal((await post({ accountId: "itau", kind: "resgate", entryDate: "2030-10-31", amountCents: 1 })).status, 409, "antes da aplicação");
  assert.equal((await post({ accountId: "itau", kind: "resgate", entryDate: "2030-11-10", amountCents: 30_000 })).status, 201);
  const list = await get("accountId=itau");
  assert.equal(list.investedCents, 70_000);
  assert.equal(list.entries.find((row) => row.kind === "aplicacao").description, "CDB");
  assert.deepEqual((await get("until=2030-11-03")).balances, [{ accountId: "itau", investedCents: 100_000 }]);
  assert.deepEqual((await get("until=2030-11-17")).balances, [{ accountId: "itau", investedCents: 70_000 }]);
  const id = list.entries[0].id;
  assert.equal((await callRoute(route.DELETE, ADMIN, "DELETE", `/api/finance/accounts/investments?id=${id}`)).status, 200);
  assert.equal((await get("accountId=itau")).entries.length, 1);
});
