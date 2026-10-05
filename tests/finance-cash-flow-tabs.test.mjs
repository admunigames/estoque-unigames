import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro 4/9 — Fluxo de Caixa em 3 abas (rotas reais sobre SQLite):
// lista de pagamentos = MESMOS itens que a projeção soma por dia; lote de
// contas (pagar/alterar vencimento); saldos semanais; recebíveis em lote e
// recebimentos futuros; escopo por loja e 403 sem finance:manage.

const db = await setupRouteDb([
  "accounts_receivable", "accounts_payable", "accounts_payable_payments", "finance_suppliers",
  "finance_items", "finance_categories", "hr_payroll_entries", "hr_employees", "hr_benefits",
  "hr_commissions", "finance_cash_flow_settings", "finance_accounts", "finance_account_balances",
  "finance_account_weekly_balances",
]);

const { todayInTimezone, addDays } = await import("../app/lib/finance-status.ts");
const { mondayOf } = await import("../app/lib/cash-flow.ts");
const cashFlow = await import("../app/api/finance/cash-flow/route.ts");
const payments = await import("../app/api/finance/cash-flow/payments/route.ts");
const paymentsBulk = await import("../app/api/finance/cash-flow/payments/bulk/route.ts");
const weekly = await import("../app/api/finance/cash-flow/weekly/route.ts");
const weeklyBalances = await import("../app/api/finance/account-weekly-balances/route.ts");
const weeklyBulk = await import("../app/api/finance/account-weekly-balances/bulk/route.ts");
const receivablesBulk = await import("../app/api/finance/receivables/bulk/route.ts");
const upcoming = await import("../app/api/finance/receivables/upcoming/route.ts");
const payablePayments = await import("../app/api/finance/payables/[id]/payments/route.ts");

const STORE_A = "criomar01";
const STORE_B = "ctacaruna1";
const ADMIN = { id: "admin", role: "admin" };
const FINANCE = { id: "fin", permissions: ["finance:manage"] };
const STORE_A_LOGIN = { id: "fin-a", companyId: STORE_A, permissions: ["finance:manage"] };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };
const today = todayInTimezone();
const d = (offset) => addDays(today, offset);

const payable = (id, row) =>
  db.insert("accounts_payable", {
    id, company_id: STORE_A, company_name: "RIOMAR", description: id.toUpperCase(), finance_item_id: "item-1",
    original_amount_cents: 10_000, paid_amount_cents: 0, competence_month: today.slice(0, 7), due_date: d(5),
    status: "open", idempotency_key: `k-${id}`, created_by: "seed", ...row,
  });

db.insert("finance_categories", { id: "cat-1", name: "OPERACIONAL" });
db.insert("finance_items", { id: "item-1", category_id: "cat-1", name: "ALUGUEL" });
db.insert("finance_suppliers", { id: "sup-1", name: "SHOPPING RIOMAR" });
payable("vencida", { due_date: d(-10), supplier_id: "sup-1" });
payable("futura", { due_date: d(3), original_amount_cents: 25_000 });
payable("parcial", { due_date: d(7), original_amount_cents: 30_000, paid_amount_cents: 10_000, status: "partially_paid" });
payable("despesa", { due_date: d(1), expense_id: "exp-1" });
payable("fornecedor", { due_date: d(2), idempotency_key: "supplier-debt:abc" });
payable("outra-loja", { company_id: STORE_B, company_name: "TACARUNA", due_date: d(4) });
payable("cancelada", { due_date: d(4), status: "canceled" });
db.insert("accounts_payable_payments", { id: "pg-agendado", payable_id: "parcial", amount_cents: 5_000, payment_date: d(6), scheduled: 1, confirmed_at: "", idempotency_key: "p1", created_by: "seed" });
db.insert("accounts_payable_payments", { id: "pg-futuro", payable_id: "parcial", amount_cents: 10_000, payment_date: d(8), scheduled: 0, confirmed_at: "2026-01-01T00:00:00Z", idempotency_key: "p2", created_by: "seed" });
db.insert("accounts_payable_payments", { id: "pg-passado", payable_id: "parcial", amount_cents: 1, payment_date: d(-20), scheduled: 0, confirmed_at: "2026-01-01T00:00:00Z", idempotency_key: "p3", created_by: "seed" });
db.insert("hr_employees", { id: "emp-1", full_name: "ANA", cpf: "1", status: "active", company_id: STORE_A, company_name: "RIOMAR", salary_cents: 200_000 });
db.insert("hr_benefits", { id: "ben-1", employee_id: "emp-1", month: today.slice(0, 7), amount_cents: 30_000, payment_date: d(9), company_id: STORE_A, company_name: "RIOMAR" });
db.insert("accounts_receivable", { id: "rec-1", company_id: STORE_A, company_name: "RIOMAR", operator_text: "STONE", competence_month: today.slice(0, 7), expected_date: d(10), expected_amount_cents: 50_000, created_by: "seed" });
db.insert("accounts_receivable", { id: "rec-atrasado", company_id: STORE_A, company_name: "RIOMAR", operator_text: "CIELO", competence_month: today.slice(0, 7), expected_date: d(-3), expected_amount_cents: 7_000, created_by: "seed" });
db.insert("accounts_receivable", { id: "rec-b", company_id: STORE_B, company_name: "TACARUNA", operator_text: "STONE", competence_month: today.slice(0, 7), expected_date: d(2), expected_amount_cents: 1_000, created_by: "seed" });
db.insert("finance_accounts", { id: "acc-a", company_id: STORE_A, company_name: "RIOMAR", name: "BANCO A", active: 1 });
db.insert("finance_accounts", { id: "acc-b", company_id: STORE_B, company_name: "TACARUNA", name: "BANCO B", active: 1 });

const json = async (response) => response.json();
const get = (handler, user, path) => callRoute(handler, user, "GET", path);
const post = (handler, user, path, body) => callRoute(handler, user, "POST", path, body);

test("sem finance:manage recebe 403 em todas as rotas novas", async () => {
  for (const [handler, method, path] of [
    [payments.GET, "GET", "/api/finance/cash-flow/payments"],
    [paymentsBulk.POST, "POST", "/api/finance/cash-flow/payments/bulk"],
    [weekly.GET, "GET", "/api/finance/cash-flow/weekly"],
    [weeklyBalances.GET, "GET", "/api/finance/account-weekly-balances"],
    [weeklyBalances.PUT, "PUT", "/api/finance/account-weekly-balances"],
    [weeklyBulk.POST, "POST", "/api/finance/account-weekly-balances/bulk"],
    [receivablesBulk.POST, "POST", "/api/finance/receivables/bulk"],
    [upcoming.GET, "GET", "/api/finance/receivables/upcoming"],
  ]) {
    const res = await callRoute(handler, NO_FINANCE, method, path, method === "GET" ? undefined : {});
    assert.equal(res.status, 403, path);
  }
});

test("REGRA DE OURO: os itens da lista somam exatamente as saídas de cada dia da projeção", async () => {
  const projection = await json(await get(cashFlow.GET, FINANCE, "/api/finance/cash-flow"));
  const list = await json(await get(payments.GET, FINANCE, `/api/finance/cash-flow/payments?from=${today}&to=${d(89)}`));
  const byDay = new Map();
  for (const item of [...list.overdue, ...list.items]) {
    const day = item.date < today ? today : item.date;
    byDay.set(day, (byDay.get(day) ?? 0) + item.amountCents);
  }
  for (const day of projection.days) assert.equal(byDay.get(day.date) ?? 0, day.saidasCents, day.date);
  assert.ok(projection.days.reduce((sum, day) => sum + day.saidasCents, 0) > 0);

  // Origem, situação, fornecedor e categoria de cada item.
  const byKey = Object.fromEntries([...list.overdue, ...list.items].map((item) => [item.key, item]));
  assert.equal(byKey["open:vencida"].status, "overdue");
  assert.equal(byKey["open:vencida"].supplierName, "SHOPPING RIOMAR");
  assert.equal(byKey["open:vencida"].categoryName, "OPERACIONAL › ALUGUEL");
  assert.equal(byKey["open:despesa"].origin, "expense");
  assert.equal(byKey["open:fornecedor"].origin, "supplier_debt");
  assert.equal(byKey["open:parcial"].amountCents, 15_000); // 30.000 − 10.000 pago − 5.000 agendado
  assert.equal(byKey["payment:pg-agendado"].status, "scheduled");
  assert.equal(byKey["payment:pg-futuro"].status, "paid");
  assert.ok(!byKey["payment:pg-passado"]);
  assert.ok(!byKey["open:cancelada"]);
  assert.ok(list.items.some((item) => item.origin === "payroll"));
  assert.ok(list.items.some((item) => item.origin === "benefits"));
  assert.deepEqual(list.overdue.map((item) => item.key), ["open:vencida"]);
});

test("lista de pagamentos: período e escopo por loja", async () => {
  const short = await json(await get(payments.GET, FINANCE, `/api/finance/cash-flow/payments?from=${d(2)}&to=${d(3)}`));
  assert.deepEqual(short.items.map((item) => item.date).every((date) => date >= d(2) && date <= d(3)), true);
  assert.equal(short.overdue.length, 1); // vencidos sempre vêm à parte
  const storeA = await json(await get(payments.GET, STORE_A_LOGIN, `/api/finance/cash-flow/payments?to=${d(89)}`));
  assert.ok(storeA.items.every((item) => item.companyId === STORE_A));
  assert.equal((await get(payments.GET, STORE_A_LOGIN, `/api/finance/cash-flow/payments?companyId=${STORE_B}`)).status, 403);
});

test("lote de contas: alterar vencimento e marcar como pago (saldo em aberto); 404 e 403", async () => {
  const path = "/api/finance/cash-flow/payments/bulk";
  let res = await post(paymentsBulk.POST, FINANCE, path, { action: "reschedule", ids: ["futura"], fields: { dueDate: d(20) } });
  assert.equal((await json(res)).applied, 1);
  assert.equal(db.sqlite.prepare("SELECT due_date FROM accounts_payable WHERE id='futura'").get().due_date, d(20));

  res = await post(paymentsBulk.POST, FINANCE, path, { action: "pay", ids: ["vencida", "parcial", "cancelada"], fields: { paymentDate: today } });
  const out = await json(res);
  assert.equal(out.applied, 2);
  assert.deepEqual(out.skipped.map((s) => s.reason), ["CONTA CANCELADA"]);
  const vencida = db.sqlite.prepare("SELECT paid_amount_cents, status FROM accounts_payable WHERE id='vencida'").get();
  assert.deepEqual([vencida.paid_amount_cents, vencida.status], [10_000, "paid"]);
  // Parcial: paga só o não coberto (15.000); o agendado continua pendente.
  assert.equal(db.sqlite.prepare("SELECT paid_amount_cents FROM accounts_payable WHERE id='parcial'").get().paid_amount_cents, 25_000);

  const list = await json(await get(payments.GET, FINANCE, `/api/finance/cash-flow/payments?to=${d(89)}`));
  assert.equal(list.overdue.length, 0); // a vencida sumiu da lista
  assert.ok(!list.items.some((item) => item.key === "open:parcial"));

  assert.equal((await post(paymentsBulk.POST, FINANCE, path, { action: "pay", ids: ["nao-existe"], fields: { paymentDate: today } })).status, 404);
  assert.equal((await post(paymentsBulk.POST, STORE_A_LOGIN, path, { action: "reschedule", ids: ["outra-loja"], fields: { dueDate: d(9) } })).status, 403);
  assert.equal((await post(paymentsBulk.POST, FINANCE, path, { action: "pay", ids: ["futura"], fields: {} })).status, 400);
});

test("pagamento individual continua igual (mesma função do lote)", async () => {
  const res = await callRoute(payablePayments.POST, ADMIN, "POST", "/api/finance/payables/futura/payments", {
    idempotencyKey: "manual-1", amountCents: 5_000, paymentDate: today,
  }, { id: "futura" });
  assert.equal(res.status, 201);
  const row = db.sqlite.prepare("SELECT paid_amount_cents, status FROM accounts_payable WHERE id='futura'").get();
  assert.deepEqual([row.paid_amount_cents, row.status], [5_000, "partially_paid"]);
  const tooMuch = await callRoute(payablePayments.POST, ADMIN, "POST", "/api/finance/payables/futura/payments", {
    idempotencyKey: "manual-2", amountCents: 999_999, paymentDate: today,
  }, { id: "futura" });
  assert.equal(tooMuch.status, 400);
});

test("saldos semanais: só segunda-feira, upsert por conta/semana e saldo atual só pela semana mais nova", async () => {
  const path = "/api/finance/account-weekly-balances";
  const monday = mondayOf(today);
  const lastMonday = addDays(monday, -7);
  const put = (user, body) => callRoute(weeklyBalances.PUT, user, "PUT", path, body);

  assert.equal((await put(FINANCE, { weekDate: addDays(monday, 1), rows: [{ accountId: "acc-a", balanceCents: 1 }] })).status, 400);
  assert.equal((await put(STORE_A_LOGIN, { weekDate: monday, rows: [{ accountId: "acc-b", balanceCents: 1 }] })).status, 403);

  assert.equal((await put(FINANCE, { weekDate: monday, rows: [{ accountId: "acc-a", balanceCents: 80_000 }, { accountId: "acc-b", balanceCents: -500 }] })).status, 200);
  assert.equal((await put(FINANCE, { weekDate: monday, rows: [{ accountId: "acc-a", balanceCents: 90_000, notes: "CORRIGIDO" }] })).status, 200);
  const rows = db.sqlite.prepare("SELECT account_id, balance_cents, notes FROM finance_account_weekly_balances WHERE week_date=? ORDER BY account_id").all(monday);
  assert.deepEqual(rows.map((r) => [r.account_id, r.balance_cents]), [["acc-a", 90_000], ["acc-b", -500]]);
  let current = db.sqlite.prepare("SELECT balance_cents, as_of_date FROM finance_account_balances WHERE account_id='acc-a'").get();
  assert.deepEqual([current.balance_cents, current.as_of_date], [90_000, monday]);

  // Semana ANTERIOR: guarda no histórico mas não mexe no saldo atual.
  assert.equal((await put(FINANCE, { weekDate: lastMonday, rows: [{ accountId: "acc-a", balanceCents: 70_000 }] })).status, 200);
  current = db.sqlite.prepare("SELECT balance_cents, as_of_date FROM finance_account_balances WHERE account_id='acc-a'").get();
  assert.deepEqual([current.balance_cents, current.as_of_date], [90_000, monday]);

  // Saldo atual com data mais nova (informado à mão) não é sobrescrito.
  db.sqlite.prepare("UPDATE finance_account_balances SET as_of_date=?, balance_cents=1 WHERE account_id='acc-b'").run(addDays(monday, 2));
  await put(FINANCE, { weekDate: monday, rows: [{ accountId: "acc-b", balanceCents: -700 }] });
  assert.equal(db.sqlite.prepare("SELECT balance_cents FROM finance_account_balances WHERE account_id='acc-b'").get().balance_cents, 1);

  const list = await json(await get(weeklyBalances.GET, STORE_A_LOGIN, path));
  assert.ok(list.rows.length >= 2 && list.rows.every((row) => row.companyId === STORE_A));
  assert.equal(list.rows[0].accountName, "BANCO A");

  // Quadro semanal: semana passada com diferença e atual partindo da segunda.
  const board = await json(await get(weekly.GET, FINANCE, `/api/finance/cash-flow/weekly?companyId=${STORE_A}`));
  assert.equal(board.weeks.length, 13);
  const past = board.weeks.find((w) => w.weekDate === lastMonday);
  assert.equal(past.kind, "past");
  assert.equal(past.informedNextCents, 90_000);
  assert.equal(past.differenceCents, 90_000 - past.expectedNextCents);
  const now = board.weeks.find((w) => w.weekDate === monday);
  assert.equal(now.kind, "current");
  assert.equal(now.startCents, 90_000);

  // Excluir em lote.
  const ids = db.sqlite.prepare("SELECT id FROM finance_account_weekly_balances WHERE week_date=?").all(lastMonday).map((r) => r.id);
  const del = await post(weeklyBulk.POST, FINANCE, `${path}/bulk`, { action: "delete", ids });
  assert.equal((await json(del)).deleted, ids.length);
  assert.equal((await post(weeklyBulk.POST, FINANCE, `${path}/bulk`, { action: "delete", ids })).status, 404);
  const bIds = db.sqlite.prepare("SELECT id FROM finance_account_weekly_balances WHERE account_id='acc-b'").all().map((r) => r.id);
  assert.equal((await post(weeklyBulk.POST, STORE_A_LOGIN, `${path}/bulk`, { action: "delete", ids: bIds })).status, 403);
});

test("recebíveis: futuros por semana/atrasados, receber e cancelar em lote", async () => {
  const future = await json(await get(upcoming.GET, STORE_A_LOGIN, "/api/finance/receivables/upcoming"));
  assert.deepEqual(future.overdue.map((r) => r.id), ["rec-atrasado"]);
  assert.deepEqual(future.upcoming.map((r) => r.id), ["rec-1"]);

  const path = "/api/finance/receivables/bulk";
  let res = await post(receivablesBulk.POST, FINANCE, path, { action: "receive", ids: ["rec-atrasado"], fields: { receivedDate: today } });
  assert.equal((await json(res)).applied, 1);
  const received = db.sqlite.prepare("SELECT received_amount_cents, received_date FROM accounts_receivable WHERE id='rec-atrasado'").get();
  assert.deepEqual([received.received_amount_cents, received.received_date], [7_000, today]);
  res = await post(receivablesBulk.POST, FINANCE, path, { action: "receive", ids: ["rec-atrasado"], fields: { receivedDate: today } });
  assert.equal((await json(res)).skipped[0].reason, "JÁ RECEBIDO");
  assert.equal((await post(receivablesBulk.POST, FINANCE, path, { action: "receive", ids: ["rec-1"], fields: {} })).status, 400);

  res = await post(receivablesBulk.POST, FINANCE, path, { action: "cancel", ids: ["rec-1"] });
  assert.equal((await json(res)).applied, 1);
  assert.equal(db.sqlite.prepare("SELECT canceled FROM accounts_receivable WHERE id='rec-1'").get().canceled, 1);
  assert.equal((await post(receivablesBulk.POST, STORE_A_LOGIN, path, { action: "cancel", ids: ["rec-b"] })).status, 403);
  assert.equal((await post(receivablesBulk.POST, FINANCE, path, { action: "cancel", ids: ["nada"] })).status, 404);
  const after = await json(await get(upcoming.GET, STORE_A_LOGIN, "/api/finance/receivables/upcoming"));
  assert.deepEqual([after.overdue.length, after.upcoming.length], [0, 0]);
});
