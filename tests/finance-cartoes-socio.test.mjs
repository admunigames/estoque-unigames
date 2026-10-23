import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// CARTÕES DE CRÉDITO SÓCIO (23/10/2026): lançamentos parcelados/fixos com
// desconto; total do mês por responsável vira conta em Contas a Pagar na
// data de pagamento (sem duplicar; atualiza; pago e mudou = 409).

const db = await setupRouteDb(["finance_partner_card_entries", "finance_partner_card_payments", "accounts_payable"]);
const lib = await import("../app/lib/partner-cards.ts");
const route = await import("../app/api/finance/partner-cards/route.ts");

const FINANCE = { id: "fin", displayName: "FIN", permissions: ["finance:manage"] };
const one = (sql, ...params) => db.prepare(sql).bind(...params).first();
const post = (body) => callRoute(route.POST, FINANCE, "POST", "/api/finance/partner-cards", body);
const put = (body) => callRoute(route.PUT, FINANCE, "PUT", "/api/finance/partner-cards", body);
const get = async (month) => (await callRoute(route.GET, FINANCE, "GET", `/api/finance/partner-cards?month=${month}`)).json();

test("parcela do mês: divide (valor − desconto), centavos na última; fixo todo mês até o fim", () => {
  const entry = { amountCents: 10_000, discountCents: 1_000, installments: 4, fixed: 0, firstMonth: "2026-10", endMonth: "" };
  assert.deepEqual(["2026-09", "2026-10", "2026-11", "2027-01", "2027-02"].map((m) => lib.installmentForMonth(entry, m).cents), [0, 2_250, 2_250, 2_250, 0]);
  const odd = { ...entry, amountCents: 10_000, discountCents: 0, installments: 3 };
  assert.deepEqual(["2026-10", "2026-11", "2026-12"].map((m) => lib.installmentForMonth(odd, m)), [
    { cents: 3_333, number: 1, total: 3 }, { cents: 3_333, number: 2, total: 3 }, { cents: 3_334, number: 3, total: 3 },
  ]);
  const fixed = { amountCents: 5_990, discountCents: 0, installments: 1, fixed: 1, firstMonth: "2026-10", endMonth: "2026-12" };
  assert.deepEqual(["2026-09", "2026-10", "2027-03", "2026-12", "2027-01"].map((m) => lib.installmentForMonth(fixed, m).cents), [0, 5_990, 0, 5_990, 0]);
  assert.equal(lib.addMonths("2026-11", 3), "2027-02");
});

test("lançamentos: validação, mês com parcela e fora do mês", async () => {
  assert.equal((await post({ responsibleName: "", description: "x", amountCents: 100, firstMonth: "2026-10" })).status, 400);
  assert.equal((await post({ responsibleName: "joão", description: "x", amountCents: 100, discountCents: 200, firstMonth: "2026-10" })).status, 400);
  assert.equal((await post({ responsibleName: "joão", description: "x", amountCents: 100, firstMonth: "2026-10", fixed: true, endMonth: "2026-09" })).status, 400);
  assert.equal((await post({ responsibleName: "joão", description: "notebook loja", purchaseDate: "2026-09-28", amountCents: 300_000, discountCents: 30_000, installments: 3, firstMonth: "2026-10" })).status, 201);
  assert.equal((await post({ responsibleName: "joão", description: "internet", amountCents: 9_990, fixed: true, firstMonth: "2026-01" })).status, 201);
  assert.equal((await post({ responsibleName: "maria", description: "passagem", amountCents: 50_000, installments: 2, firstMonth: "2026-11" })).status, 201);

  const oct = await get("2026-10");
  assert.deepEqual(oct.names, ["JOÃO", "MARIA"]);
  assert.deepEqual(oct.entries.map((e) => [e.description, e.monthCents, e.installmentNumber]), [["INTERNET", 9_990, 0], ["NOTEBOOK LOJA", 90_000, 1]]);
  assert.deepEqual(oct.others.map((e) => e.description), ["PASSAGEM"]);
  assert.deepEqual(oct.summary.map((s) => [s.responsibleName, s.totalCents, s.payableId]), [["JOÃO", 99_990, ""]]);
});

test("data de pagamento: total do mês vira conta a pagar; reenviar atualiza; pago e mudou = 409", async () => {
  assert.equal((await put({ responsibleName: "joão", month: "2026-10", paymentDate: "" })).status, 400);
  assert.equal((await put({ responsibleName: "ninguém", month: "2026-10", paymentDate: "2026-11-05" })).status, 400);
  const first = await put({ responsibleName: "joão", month: "2026-10", paymentDate: "2026-11-05" });
  assert.equal(first.status, 200);
  const { payableId } = await first.json();
  const payable = await one("SELECT description, original_amount_cents AS v, due_date AS d, company_id AS c, dre_target AS t, competence_month AS m FROM accounts_payable WHERE id = ?", payableId);
  assert.deepEqual({ ...payable }, { description: "CARTÃO SÓCIO — JOÃO — 10/2026", v: 99_990, d: "2026-11-05", c: "", t: "none", m: "2026-10" });

  let oct = await get("2026-10");
  assert.equal(oct.summary[0].payableId, payableId);
  assert.equal(oct.summary[0].paymentDate, "2026-11-05");
  assert.equal(oct.summary[0].outdated, false);

  // Novo lançamento no mês → conta desatualizada; reenviar atualiza a MESMA conta.
  await post({ responsibleName: "joão", description: "cabo", amountCents: 10, firstMonth: "2026-10" });
  oct = await get("2026-10");
  assert.equal(oct.summary[0].outdated, true);
  const again = await (await put({ responsibleName: "JOÃO", month: "2026-10", paymentDate: "2026-11-10" })).json();
  assert.equal(again.payableId, payableId);
  assert.equal((await one("SELECT COUNT(*) AS n FROM accounts_payable")).n, 1);
  assert.deepEqual({ ...(await one("SELECT original_amount_cents AS v, due_date AS d FROM accounts_payable")) }, { v: 100_000, d: "2026-11-10" });

  // Já pago e o total mudou → 409.
  await db.prepare("UPDATE accounts_payable SET paid_amount_cents = 100000, status = 'paid'").run();
  await post({ responsibleName: "joão", description: "mouse", amountCents: 5_000, firstMonth: "2026-10" });
  assert.equal((await put({ responsibleName: "joão", month: "2026-10", paymentDate: "2026-11-10" })).status, 409);
});

test("editar e excluir lançamento; sem finance:manage = 403", async () => {
  const nov = await get("2026-11");
  const passagem = nov.entries.find((e) => e.description === "PASSAGEM");
  assert.equal((await post({ ...passagem, amountCents: 60_000, installments: 3 })).status, 200);
  assert.equal((await get("2026-11")).entries.find((e) => e.id === passagem.id).monthCents, 20_000);
  assert.equal((await callRoute(route.DELETE, FINANCE, "DELETE", `/api/finance/partner-cards?id=${passagem.id}`)).status, 200);
  assert.equal((await get("2026-11")).entries.some((e) => e.id === passagem.id), false);
  assert.equal((await callRoute(route.GET, { id: "x", permissions: ["stock:view"] }, "GET", "/api/finance/partner-cards?month=2026-10")).status, 403);
});

test("tela: aba CARTÕES DE CRÉDITO SÓCIO com os campos pedidos", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /data-corp-view="socio">CARTÕES DE CRÉDITO SÓCIO<\/button>/);
  for (const id of ["pcResponsible", "pcPurchaseDate", "pcDescription", "pcAmount", "pcDiscount", "pcFixed", "pcInstallments", "pcFirstMonth", "pcSummaryBody", "pcEntriesBody"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /LANÇAR EM CONTAS A PAGAR/);
});
