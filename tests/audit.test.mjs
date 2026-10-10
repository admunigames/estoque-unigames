import assert from "node:assert/strict";
import test from "node:test";

const audit = await import("../app/lib/audit.ts");

test("shouldAudit: só gravações em /api, sem preferências/push/sessão", () => {
  assert.equal(audit.shouldAudit("POST", "/api/divergences"), true);
  assert.equal(audit.shouldAudit("DELETE", "/api/finance/payables/abc"), true);
  assert.equal(audit.shouldAudit("GET", "/api/divergences"), false);
  assert.equal(audit.shouldAudit("PUT", "/api/preferences"), false);
  assert.equal(audit.shouldAudit("POST", "/api/push/subscribe"), false);
  assert.equal(audit.shouldAudit("POST", "/login"), false);
});

test("auditModule: nome do módulo pelo caminho (o mais específico primeiro)", () => {
  assert.equal(audit.auditModule("/api/finance/payables/x/pay"), "CONTAS A PAGAR");
  assert.equal(audit.auditModule("/api/finance/categories"), "FINANCEIRO");
  assert.equal(audit.auditModule("/api/compras-novo/orders/1/items"), "COMPRAS");
  assert.equal(audit.auditModule("/api/hr-payroll/abc"), "RH");
  assert.equal(audit.auditModule("/api/gorduras-assistencia"), "CONTROLE GORDURAS ASSISTÊNCIA");
  assert.equal(audit.auditModule("/api/modulo-novo/x"), "MODULO NOVO");
});

test("auditAction e auditRecordId", () => {
  const uuid = "99ba61ee-2ea1-4d9c-bb69-8ac5057d2f0d";
  assert.equal(audit.auditAction("POST", "/api/divergences"), "CADASTROU");
  assert.equal(audit.auditAction("PATCH", `/api/compras-novo/orders/${uuid}`), "ALTEROU");
  assert.equal(audit.auditAction("DELETE", `/api/finance/payables/${uuid}`), "EXCLUIU");
  assert.equal(audit.auditAction("POST", `/api/compras-novo/orders/${uuid}/attachments`), "ANEXO");
  assert.equal(audit.auditAction("DELETE", `/api/compras-novo/orders/${uuid}/attachments/${uuid}`), "EXCLUIU ANEXO");
  assert.equal(audit.auditAction("POST", `/api/divergences/${uuid}/items/${uuid}/respond`), "STATUS / ANDAMENTO");
  assert.equal(audit.auditAction("POST", "/api/finance/payables/bulk"), "CADASTROU EM LOTE");
  assert.equal(audit.auditRecordId(`/api/compras-novo/orders/${uuid}/items`), uuid);
  assert.equal(audit.auditRecordId("/api/controle-gd", { created: true, id: "abc-123" }), "abc-123");
  assert.equal(audit.auditRecordId("/api/controle-gd", { updated: true }), "");
});

test("auditSummary: só campos da lista branca, nunca senha/documento", () => {
  const summary = audit.auditSummary({ name: "OEX", password: "segredo", cpf: "123", status: "aberto", ids: [1, 2, 3] });
  assert.match(summary, /name: OEX/);
  assert.match(summary, /status: aberto/);
  assert.match(summary, /ids: 3/);
  assert.doesNotMatch(summary, /segredo|123/);
  assert.equal(audit.auditSummary(null), "");
  assert.equal(audit.auditSummary([1, 2]), "");
});

test("rota /api/audit: permissão própria e filtros", async () => {
  const { callRoute, setupRouteDb } = await import("./helpers/route-db.mjs");
  const db = await setupRouteDb(["audit_log"]);
  const route = await import("../app/api/audit/route.ts");
  const row = (id, at, userName, module, action, summary) =>
    db.insert("audit_log", { id, at, user_id: userName.toLowerCase(), user_name: userName, company_id: "", method: "POST", path: "/api/x", module, action, record_id: id, summary, status: 200 });
  row("r1", "2026-10-09T13:00:00.000Z", "BRENNDHA", "DIVERGÊNCIAS", "CADASTROU", "name: CABO");
  row("r2", "2026-10-10T13:00:00.000Z", "RENATO", "COMPRAS", "EXCLUIU", "name: OEX");
  const get = (user, query = "") => callRoute(route.GET, user, "GET", `/api/audit${query}`);
  assert.equal((await get({ id: "x", permissions: ["divergencias:view"] })).status, 403);
  const viewer = { id: "a", permissions: ["audit:view"] };
  const all = await (await get(viewer)).json();
  assert.deepEqual(all.rows.map((r) => r.id), ["r2", "r1"]);
  assert.deepEqual(all.modules, ["COMPRAS", "DIVERGÊNCIAS"]);
  assert.deepEqual((await (await get(viewer, "?module=COMPRAS")).json()).rows.map((r) => r.id), ["r2"]);
  assert.deepEqual((await (await get(viewer, "?user=brenn")).json()).rows.map((r) => r.id), ["r1"]);
  assert.deepEqual((await (await get(viewer, "?from=2026-10-10&to=2026-10-10")).json()).rows.map((r) => r.id), ["r2"]);
  assert.deepEqual((await (await get(viewer, "?q=cabo")).json()).rows.map((r) => r.id), ["r1"]);
});
