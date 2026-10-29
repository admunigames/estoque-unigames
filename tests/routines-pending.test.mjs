import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Rotina não feita em vários dias = UMA linha por loja (usuário, 28/10/2026);
// marcar FEITA conclui todas as cópias pendentes.

const db = await setupRouteDb(["shared_state", "operational_routines", "operational_routine_tasks", "push_subscriptions"]);
const route = await import("../app/api/routines/route.ts");

const ALFA = "clojaalfa1";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife" }).format(new Date());
const daysAgo = (n) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("operational_routines", { id: "r1", title: "CHECK-IN", scope: "general", weekdays: "0,1,2,3,4,5,6", active: 1, created_by: "admin", created_by_name: "ADMIN" });
for (const n of [3, 2, 1]) {
  db.insert("operational_routine_tasks", { id: `t${n}`, routine_id: "r1", company_id: ALFA, company_name: "LOJA ALFA", origin_date: daysAgo(n), due_date: daysAgo(n), status: "todo" });
}
const STORE = { id: "loja", role: "user", companyId: ALFA, permissions: ["missions"] };
const list = async () => (await (await callRoute(route.GET, STORE, "GET", `/api/routines?date=${today}`)).json()).tasks;

test("pendências acumuladas viram uma linha e FEITA conclui todas", async () => {
  const tasks = await list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].pendingCount, 4);
  assert.equal(tasks[0].pendingSince, daysAgo(3));

  const response = await callRoute(route.PATCH, STORE, "PATCH", "/api/routines", { taskId: tasks[0].id, status: "completed" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const after = await list();
  assert.equal(after.length, 1);
  assert.equal(after[0].completed, true);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM operational_routine_tasks WHERE status<>'completed'").get().n, 0);
});
