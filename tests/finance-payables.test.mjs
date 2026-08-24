import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Estes testes cobrem a lógica pura (sem banco) do módulo Contas a Pagar —
// regime de competência, status calculado, recorrência e parcelamento. Não
// tocam banco de dados: rotas que fazem SQL cru só rodam de verdade dentro
// do runtime do Cloudflare Workers (ver nota em
// app/api/finance/dre/route.ts e memória do projeto), então a cobertura de
// integração (isolamento por loja, transação, idempotência) é validada
// manualmente com o client `postgres` antes de aplicar cada migration em
// produção — o mesmo método já usado nas etapas anteriores da DRE.

const financeStatus = await import("../app/lib/finance-status.ts");
const payablesShared = await import("../app/lib/payables-recurrence.ts");
const brDocuments = await import("../app/lib/br-documents.ts");

test("status calculado: conta vencida tem prioridade mesmo se parcialmente paga", () => {
  const status = financeStatus.computeDisplayStatus({
    storedStatus: "partially_paid",
    dueDate: "2026-08-20",
    today: "2026-08-24",
  });
  assert.equal(status, "overdue");
});

test("status calculado: vencendo hoje e a vencer", () => {
  assert.equal(
    financeStatus.computeDisplayStatus({ storedStatus: "open", dueDate: "2026-08-24", today: "2026-08-24" }),
    "due_today",
  );
  assert.equal(
    financeStatus.computeDisplayStatus({ storedStatus: "open", dueDate: "2026-08-30", today: "2026-08-24" }),
    "upcoming",
  );
});

test("status calculado: pago e cancelado sempre vencem independente da data", () => {
  assert.equal(
    financeStatus.computeDisplayStatus({ storedStatus: "paid", dueDate: "2020-01-01", today: "2026-08-24" }),
    "paid",
  );
  assert.equal(
    financeStatus.computeDisplayStatus({ storedStatus: "canceled", dueDate: "2020-01-01", today: "2026-08-24" }),
    "canceled",
  );
});

test("status armazenado: pagamento integral marca 'paid', parcial marca 'partially_paid'", () => {
  assert.equal(
    financeStatus.computeStoredStatus({
      originalAmountCents: 1000,
      paidAmountCents: 1000,
      canceled: false,
      hasPendingSchedule: false,
    }),
    "paid",
  );
  assert.equal(
    financeStatus.computeStoredStatus({
      originalAmountCents: 1000,
      paidAmountCents: 500,
      canceled: false,
      hasPendingSchedule: false,
    }),
    "partially_paid",
  );
  assert.equal(
    financeStatus.computeStoredStatus({
      originalAmountCents: 1000,
      paidAmountCents: 0,
      canceled: false,
      hasPendingSchedule: true,
    }),
    "scheduled",
  );
  assert.equal(
    financeStatus.computeStoredStatus({
      originalAmountCents: 1000,
      paidAmountCents: 0,
      canceled: true,
      hasPendingSchedule: false,
    }),
    "canceled",
  );
});

test("visões rápidas: intervalos de data não se sobrepõem de forma ambígua", () => {
  const today = "2026-08-24"; // segunda-feira
  assert.deepEqual(financeStatus.quickViewDueRange("today", today), { from: today, to: today });
  assert.deepEqual(financeStatus.quickViewDueRange("tomorrow", today), { from: "2026-08-25", to: "2026-08-25" });
  assert.deepEqual(financeStatus.quickViewDueRange("week", today), { from: "2026-08-24", to: "2026-08-30" });
  assert.deepEqual(financeStatus.quickViewDueRange("next7", today), { from: "2026-08-24", to: "2026-08-31" });
  assert.deepEqual(financeStatus.quickViewDueRange("month", today), { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(financeStatus.quickViewDueRange("year", today), { from: "2026-01-01", to: "2026-12-31" });
});

test("parcelamento: soma das parcelas bate com o valor original, resto vai na última", () => {
  const amounts = payablesShared.splitIntoInstallments(1000, 3); // R$10,00 em 3x
  assert.deepEqual(amounts, [333, 333, 334]);
  assert.equal(amounts.reduce((sum, value) => sum + value, 0), 1000);
});

test("parcelamento: vencimentos mensais sucessivos a partir da 1ª parcela", () => {
  const dueDates = payablesShared.generateInstallmentDueDates("2026-01-31", 4);
  // Meses com menos dias (fevereiro) caem no último dia do mês, não estouram pro mês seguinte.
  assert.deepEqual(dueDates, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("recorrência: frequência mensal soma 1 mês, semanal soma 7 dias", () => {
  assert.equal(payablesShared.nextRecurrenceDueDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(payablesShared.nextRecurrenceDueDate("2026-08-24", "weekly"), "2026-08-31");
  assert.equal(payablesShared.nextRecurrenceDueDate("2026-08-24", "quarterly"), "2026-11-24");
});

test("recorrência: gera ocorrências até a quantidade informada, sem duplicar a primeira data", () => {
  const dates = payablesShared.generateRecurrenceDueDates({
    firstDueDate: "2026-01-05",
    frequency: "monthly",
    occurrenceCount: 3,
    endDate: "",
  });
  assert.deepEqual(dates, ["2026-01-05", "2026-02-05", "2026-03-05"]);
});

test("recorrência: respeita a data final quando não há quantidade de ocorrências", () => {
  const dates = payablesShared.generateRecurrenceDueDates({
    firstDueDate: "2026-08-03",
    frequency: "weekly",
    occurrenceCount: null,
    endDate: "2026-08-24",
  });
  assert.deepEqual(dates, ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]);
});

test("competência é sempre derivada do vencimento (AAAA-MM)", () => {
  assert.equal(payablesShared.competenceMonthOf("2026-03-15"), "2026-03");
});

test("recalcPayableEntrySql nunca sobrescreve um lançamento manual da DRE (guarda source='payable')", () => {
  const statements = payablesShared.recalcPayableEntrySql("entry-1", "store-1", "item-1", "2026-08", "user-1", "Fulano");
  assert.equal(statements.length, 2);
  const [deleteStatement, upsertStatement] = statements;
  assert.match(deleteStatement[0], /DELETE FROM finance_store_entries/);
  assert.match(deleteStatement[0], /source='payable'/);
  assert.match(upsertStatement[0], /ON CONFLICT \(store_id, item_id, month\) DO UPDATE/);
  assert.match(upsertStatement[0], /WHERE finance_store_entries\.source = 'payable'/);
});

test("página Contas a Pagar existe no submenu Financeiro, gated por finance:manage, com rota própria", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="navFinanceiroPayables"[^>]*data-page="financeiroPayables"[^>]*data-permission="finance"/);
  assert.match(html, /id="pageFinanceiroPayables"/);
  assert.match(html, /financeiroPayables:\s*'\/financeiro\/contas-a-pagar'/);
});

// ---- Documentos brasileiros (CPF/CNPJ/Pix) — app/lib/br-documents.ts ----

test("CPF: aceita dígitos verificadores corretos e rejeita sequência repetida", () => {
  assert.equal(brDocuments.isValidCpf("111.444.777-35"), true);
  assert.equal(brDocuments.isValidCpf("111.444.777-36"), false);
  assert.equal(brDocuments.isValidCpf("111.111.111-11"), false);
  assert.equal(brDocuments.isValidCpf("123"), false);
});

test("CNPJ: aceita dígitos verificadores corretos e rejeita sequência repetida", () => {
  assert.equal(brDocuments.isValidCnpj("11.222.333/0001-81"), true);
  assert.equal(brDocuments.isValidCnpj("11.222.333/0001-82"), false);
  assert.equal(brDocuments.isValidCnpj("11.111.111/1111-11"), false);
});

test("CPF/CNPJ combinado: decide pelo tamanho do documento informado", () => {
  assert.equal(brDocuments.isValidCpfOrCnpj("111.444.777-35"), true);
  assert.equal(brDocuments.isValidCpfOrCnpj("11.222.333/0001-81"), true);
  assert.equal(brDocuments.isValidCpfOrCnpj("12345"), false);
});

test("chave Pix: valida formato de acordo com o tipo selecionado", () => {
  assert.equal(brDocuments.isValidPixKey("cliente@banco.com", "email"), true);
  assert.equal(brDocuments.isValidPixKey("nao-e-email", "email"), false);
  assert.equal(brDocuments.isValidPixKey("11999998888", "phone"), true);
  assert.equal(brDocuments.isValidPixKey("123", "phone"), false);
  assert.equal(brDocuments.isValidPixKey("111.444.777-35", "cpf"), true);
  assert.equal(brDocuments.isValidPixKey("11.222.333/0001-81", "cpf"), false);
  assert.equal(brDocuments.isValidPixKey("a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789", "random"), true);
  assert.equal(brDocuments.isValidPixKey("chave-qualquer", "random"), false);
});

// ---- Categoria/Item e conta financeira: estrutura da UI e migration ----

test("formulário de Contas a Pagar tem categoria e item em cascata, com cadastro inline", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="payableCategory"/);
  assert.match(html, /id="payableItem"/);
  assert.match(html, /id="btnTogglePayableNewCategory"/);
  assert.match(html, /id="btnTogglePayableNewItem"/);
  assert.match(html, /id="payableItemSearch"/);
  // Item filtrado pela categoria selecionada, nunca lista tudo de uma vez.
  assert.match(html, /function renderPayableItemOptions\(/);
});

test("filtros de Contas a Pagar também têm categoria e item separados", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="payablesCategory"/);
  assert.match(html, /id="payablesItem"/);
});

test("cadastro de conta financeira tem os campos bancários completos e é isolado por loja", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  [
    "payableAccountCompany",
    "payableAccountType",
    "payableAccountBankName",
    "payableAccountBankCode",
    "payableAccountAgency",
    "payableAccountAgencyDigit",
    "payableAccountNumber",
    "payableAccountDigit",
    "payableAccountHolderName",
    "payableAccountHolderDocument",
    "payableAccountPixType",
    "payableAccountPixKey",
    "payableAccountOpeningBalance",
    "payableAccountOpeningDate",
    "payableAccountActive",
  ].forEach((id) => assert.match(html, new RegExp('id="' + id + '"'), `campo ${id} ausente`));
});

test("migration 0029 adiciona empresa/loja e os campos bancários em finance_accounts", async () => {
  const sql = await readFile(new URL("../drizzle/0029_unknown_silver_surfer.sql", import.meta.url), "utf8");
  [
    "company_id",
    "bank_name",
    "bank_code",
    "agency",
    "agency_digit",
    "account_number",
    "account_digit",
    "holder_name",
    "holder_document",
    "pix_key_type",
    "pix_key",
    "opening_balance_cents",
    "opening_balance_date",
  ].forEach((column) => assert.match(sql, new RegExp('"' + column + '"'), `coluna ${column} ausente na migration`));
  assert.match(sql, /finance_accounts_type_check/);
});
