import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Aparelhos de Empréstimo: a loja informa a devolução (EM DEVOLUÇÃO) e quem
// gerencia marca DEVOLVIDO na chegada (aparelho volta a ficar disponível).

const db = await setupRouteDb(["shared_state", "loan_devices", "loan_requests", "loan_request_updates"]);
const A = "clojaalfa1", B = "clojabeta1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: A, name: "LOJA ALFA" }, { id: B, name: "LOJA BETA" }]) });
db.insert("loan_devices", { id: "d1", name: "IPHONE 13", status: "available", created_by: "admin" });
const route = await import("../app/api/loans/requests/route.ts");
const STORE_A = { id: "loja-a", companyId: A, permissions: ["loans:request"] };
const STORE_B = { id: "loja-b", companyId: B, permissions: ["loans:request"] };
const MANAGER = { id: "estoque", permissions: ["loans:manage_requests"] };
const patch = (user, body) => callRoute(route.PATCH, user, "PATCH", "/api/loans/requests", body);
const row = (id) => db.sqlite.prepare("SELECT status FROM loan_requests WHERE id=?").get(id);
const device = () => db.sqlite.prepare("SELECT status FROM loan_devices WHERE id='d1'").get();

test("loja informa devolução; quem gerencia marca devolvido na chegada", async () => {
  const created = await callRoute(route.POST, STORE_A, "POST", "/api/loans/requests", { deviceId: "d1", responsibleName: "BRENNDHA", reason: "CLIENTE" });
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const id = (await created.json()).id;
  assert.equal((await patch(STORE_A, { id, action: "returning" })).status, 409, "ainda não emprestado");
  assert.equal((await patch(MANAGER, { id, action: "loan" })).status, 200);
  assert.equal((await patch(STORE_B, { id, action: "returning" })).status, 404, "outra loja não enxerga");
  assert.equal((await patch(STORE_A, { id, action: "return" })).status, 403, "loja não marca devolvido");
  assert.equal((await patch(STORE_A, { id, action: "returning", note: "VAI PELO MOTOBOY" })).status, 200);
  assert.equal(row(id).status, "returning");
  assert.equal(device().status, "loaned", "segue emprestado até chegar");
  assert.equal((await patch(STORE_A, { id, action: "returning" })).status, 409, "já informada");
  const updates = db.sqlite.prepare("SELECT message, author_name FROM loan_request_updates WHERE request_id=?").all(id);
  assert.match(updates[0].message, /LOJA INFORMOU A DEVOLUÇÃO DO APARELHO\. VAI PELO MOTOBOY/);
  assert.equal((await patch(MANAGER, { id, action: "return" })).status, 200);
  assert.equal(row(id).status, "returned");
  assert.equal(device().status, "available");
});
