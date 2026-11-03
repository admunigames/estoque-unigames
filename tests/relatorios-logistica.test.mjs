import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Estoque > Relatórios Logística: PDF vai por e-mail (Resend) e NÃO é
// guardado; no banco só o registro. Loja só envia/vê a própria loja.

const db = await setupRouteDb(["shared_state", "logistics_reports"]);
const route = await import("../app/api/relatorios-logistica/route.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: A, name: "Guararapes" }, { id: B, name: "TACARUNA" }]) });

const LOJA_A = { id: "loja-a", name: "GERENTE A", companyId: A, permissions: ["relatorios_logistica:send"] };
const LOGISTICA = { id: "log", name: "LOGÍSTICA", permissions: ["relatorios_logistica:view"] };
const NADA = { id: "x", name: "X", permissions: [] };
const PDF = new TextEncoder().encode("%PDF-1.4\n%fake\n");

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
  return Response.json({ id: `email-${sent.length}` });
};
// callRoute manda JSON; aqui o corpo é o PDF cru.
const post = (actor, query, body = PDF) => route.POST(new Request(`http://127.0.0.1/api/relatorios-logistica?${query}`, {
  method: "POST",
  headers: {
    "x-unigames-user-id": actor.id, "x-unigames-display-name": encodeURIComponent(actor.name), "x-unigames-role": "user",
    "x-unigames-company-id": actor.companyId || "", "x-unigames-permissions": actor.permissions.join(","),
    "sec-fetch-site": "same-origin", "content-type": "application/pdf",
  },
  body,
}));
const list = async (actor) => (await callRoute(route.GET, actor, "GET", "/api/relatorios-logistica")).json();

test("sem RESEND_API_KEY: não envia", async () => {
  delete process.env.RESEND_API_KEY;
  assert.equal((await post(LOJA_A, `companyId=${A}&reportDate=2026-11-01`)).status, 503);
  assert.equal((await list(LOJA_A)).configured, false);
});

test("loja envia o PDF por e-mail, só da própria loja; só o registro fica", async () => {
  process.env.RESEND_API_KEY = "re_teste";
  assert.equal((await callRoute(route.GET, NADA, "GET", "/api/relatorios-logistica")).status, 403);
  assert.equal((await post(LOJA_A, `companyId=${B}&reportDate=2026-11-01`)).status, 400);
  assert.equal((await post(LOJA_A, `companyId=${A}&reportDate=2099-01-01`)).status, 400);
  assert.equal((await post(LOJA_A, `companyId=${A}&reportDate=2026-11-01`, new TextEncoder().encode("oi"))).status, 400);
  assert.equal((await post(LOGISTICA, `companyId=${A}&reportDate=2026-11-01`)).status, 403);
  assert.equal(sent.length, 0);

  const ok = await post(LOJA_A, `companyId=${A}&reportDate=2026-11-01&fileName=scan.pdf`);
  assert.equal(ok.status, 201);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(sent[0].auth, "Bearer re_teste");
  assert.deepEqual(sent[0].body.to, ["estoque.unigames@gmail.com"]);
  assert.equal(sent[0].body.subject, "RELATÓRIO LOGÍSTICA - GUARARAPES - 01/11/2026");
  assert.equal(sent[0].body.attachments[0].filename, "RELATORIO-LOGISTICA-GUARARAPES-2026-11-01.pdf");
  assert.equal(Buffer.from(sent[0].body.attachments[0].content, "base64").toString(), "%PDF-1.4\n%fake\n");

  const row = db.sqlite.prepare("SELECT * FROM logistics_reports").get();
  assert.equal(row.company_id, A);
  assert.equal(row.email_id, "email-1");
  assert.equal(row.sent_by_name, "GERENTE A");
  assert.ok(!Object.keys(row).some((column) => /content|data|blob/.test(column)));

  const loja = await list(LOJA_A);
  assert.deepEqual(loja.stores.map((store) => store.id), [A]);
  assert.equal(loja.reports.length, 1);
  const logistica = await list(LOGISTICA);
  assert.equal(logistica.stores.length, 2);
  assert.equal(logistica.reports[0].companyName, "GUARARAPES");
  assert.equal(logistica.canSend, false);
});

test("Resend recusa: erro e nada registrado", async () => {
  globalThis.fetch = async () => Response.json({ message: "invalid" }, { status: 422 });
  assert.equal((await post(LOJA_A, `companyId=${A}&reportDate=2026-11-02`)).status, 502);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM logistics_reports").get().n, 1);
});
