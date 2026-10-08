import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// EXCLUIR conta a pagar de vez (individual e em lote): só cancelada, sem
// pagamento confirmado, não de NF; conta de despesa leva a despesa inteira.

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "accounts_payable_payment_attachments",
  "supplier_open_debts", "supplier_invoice_installments", "expenses", "expense_rateio_shares", "expense_attachments",
]);
const single = await import("../app/api/finance/payables/[id]/route.ts");
const bulk = await import("../app/api/finance/payables/bulk/route.ts");

const STORE = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
const FIN = { id: "u-fin", permissions: ["finance:manage"] };
const OTHER = { id: "u-x", permissions: ["stock:view"] };

let seq = 0;
function payable(overrides = {}) {
  const id = overrides.id || `ap-${++seq}`;
  db.insert("accounts_payable", {
    id, company_id: STORE, company_name: "LOJA ALFA", description: overrides.description || id, supplier_id: "",
    finance_item_id: "", finance_account_id: "", original_amount_cents: 1000, paid_amount_cents: 0,
    issue_date: "2026-10-01", competence_month: "2026-10", due_date: "2026-10-15", payment_method: "",
    invoice_number: "", order_reference: "", billing_code: "", notes: "", status: "canceled",
    idempotency_key: id, created_by: "admin", created_by_name: "ADMIN", ...overrides,
  });
  return id;
}
const exists = (table, id) => Boolean(db.sqlite.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id));
const del = (actor, id) => callRoute(single.DELETE, actor, "DELETE", `/api/finance/payables/${id}`, undefined, { id });

test("individual: só cancelada; aberta = 409 com o motivo; sem permissão = 403", async () => {
  const open = payable({ status: "open" });
  const res = await del(FIN, open);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /CANCELE A CONTA ANTES/);
  const canceled = payable();
  assert.equal((await del(OTHER, canceled)).status, 403);
  const paymentId = "pay-1";
  db.insert("accounts_payable_payments", { id: paymentId, payable_id: canceled, amount_cents: 500, payment_date: "2026-10-02", scheduled: 1, confirmed_at: "", created_by: "admin" });
  db.insert("accounts_payable_payment_attachments", { id: "att-1", payment_id: paymentId, file_name: "x.pdf", created_by: "admin" });
  db.insert("supplier_open_debts", { id: "debt-1", accounts_payable_id: canceled, company_id: STORE, canceled: 1 });
  assert.equal((await del(FIN, canceled)).status, 200);
  assert.ok(!exists("accounts_payable", canceled));
  assert.ok(!exists("accounts_payable_payments", paymentId), "agendamento não confirmado sai junto");
  assert.ok(!exists("accounts_payable_payment_attachments", "att-1"));
  assert.ok(!exists("supplier_open_debts", "debt-1"), "a dívida gêmea sai junto");
});

test("bloqueios: pagamento confirmado e duplicata de nota fiscal", async () => {
  const paid = payable();
  db.insert("accounts_payable_payments", { id: "pay-2", payable_id: paid, amount_cents: 1000, payment_date: "2026-10-02", scheduled: 0, confirmed_at: "2026-10-02T10:00:00Z", created_by: "admin" });
  const res = await del(FIN, paid);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /PAGAMENTO REGISTRADO/);
  const fromInvoice = payable();
  db.insert("supplier_invoice_installments", { id: "inst-1", accounts_payable_id: fromInvoice, invoice_id: "nf-1" });
  assert.match((await (await del(FIN, fromInvoice)).json()).error, /NOTA FISCAL/);
  assert.ok(exists("accounts_payable", paid) && exists("accounts_payable", fromInvoice));
});

test("despesa rateada: exclui a despesa inteira só com todas as fatias canceladas; cartão/extrato bloqueia", async () => {
  db.insert("expenses", { id: "exp-1", company_id: STORE, company_name: "LOJA ALFA", description: "CARTOES DE VISITA", original_amount_cents: 3000, issue_date: "2026-10-01", competence_month: "2026-10", due_date: "2026-10-15", rateio_type: "rateio", idempotency_key: "e1", created_by: "admin", card_id: "", bank_reconciliation_id: "" });
  const a = payable({ expense_id: "exp-1" });
  const b = payable({ expense_id: "exp-1", status: "open" });
  db.insert("expense_rateio_shares", { id: "sh-1", expense_id: "exp-1", company_id: STORE, percent_basis_points: 10000, amount_cents: 3000 });
  assert.match((await (await del(FIN, a)).json()).error, /OUTRAS CONTAS NÃO CANCELADAS/);
  db.sqlite.prepare("UPDATE accounts_payable SET status='canceled' WHERE id=?").run(b);
  assert.equal((await del(FIN, a)).status, 200);
  for (const id of [a, b]) assert.ok(!exists("accounts_payable", id));
  assert.ok(!exists("expenses", "exp-1"));
  assert.ok(!exists("expense_rateio_shares", "sh-1"));

  db.insert("expenses", { id: "exp-card", company_id: STORE, company_name: "LOJA ALFA", description: "CARTAO", original_amount_cents: 100, issue_date: "2026-10-01", competence_month: "2026-10", due_date: "2026-10-15", rateio_type: "single_store", idempotency_key: "e2", created_by: "admin", card_id: "card-1", bank_reconciliation_id: "" });
  const fromCard = payable({ expense_id: "exp-card" });
  assert.match((await (await del(FIN, fromCard)).json()).error, /CARTÃO OU DO EXTRATO/);
});

test("lote: exclui as canceladas e pula as demais com o motivo", async () => {
  const c1 = payable();
  const c2 = payable();
  const open = payable({ status: "open" });
  const res = await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/payables/bulk", { action: "delete", ids: [c1, c2, open] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.applied, 2);
  assert.deepEqual(body.skipped.map((s) => s.id), [open]);
  assert.ok(!exists("accounts_payable", c1) && !exists("accounts_payable", c2) && exists("accounts_payable", open));
});
