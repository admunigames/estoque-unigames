import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import { repeatedEntryIds, replacementBalances, type BalanceEntry, type BalanceRow } from "../../../lib/replacement-balance";
import {
  closedMonthError,
  closedReplacementMonths,
  insertReplacementStatement,
  KIND_GROUPS,
  parseReplacementEntry,
  planReplacementDelete,
  SECTORS,
} from "./shared";
import { loadPayable, planPayablePayment } from "../payables/shared";

// Controle de Reposição (Financeiro — Fase 8). Registra valores repostos/
// gastos por Assistência, Logística e outros setores. "Adicionar como
// Despesa" é feito pelo front (POST /finance/expenses) que devolve o
// expense_id via PATCH aqui — a lógica de despesa/DRE não é duplicada.

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// Só os tipos de saída de dinheiro podem virar Despesa.
// OUTROS (SAÍDA) não é classificado (27/11/2026): fica FINALIZADO sem despesa.
const EXPENSE_ELIGIBLE_KINDS = new Set(KIND_GROUPS.saida.filter((kind) => kind !== "outros_saida"));

type Row = Record<string, unknown>;

const SELECT_COLUMNS = `id, entry_date AS entryDate, company_id AS companyId, company_name AS companyName,
  product, reason, sector, responsible_name AS responsibleName, amount_cents AS amountCents,
  kind, notes, expense_id AS expenseId, bank_entry_id AS bankEntryId,
  category, finance_item_id AS financeItemId,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const params = new URL(request.url).searchParams;
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (fragment: string, value: unknown) => {
    values.push(value);
    conditions.push(fragment.replace("?", `?${values.length}`));
  };

  const companyId = safeText(params.get("companyId"), 80);
  if (companyId) add("company_id = ?", companyId);
  const sector = safeText(params.get("sector"), 20);
  if (SECTORS.has(sector)) add("sector = ?", sector);
  // ENTRADA / SAÍDA (com os tipos antigos de cada grupo).
  const kindGroup = KIND_GROUPS[safeText(params.get("kind"), 20)];
  if (kindGroup) {
    const start = values.length;
    values.push(...kindGroup);
    conditions.push(`kind IN (${kindGroup.map((_, index) => `?${start + index + 1}`).join(",")})`);
  }
  // RESPONSÁVEL: escolhido na lista ou parte do nome digitado (nomes gravados em CAIXA ALTA).
  const responsible = safeText(params.get("responsible"), 160).toLocaleUpperCase("pt-BR");
  if (responsible) add("UPPER(responsible_name) LIKE ?", `%${responsible}%`);
  const category = safeText(params.get("category"), 120).toLocaleUpperCase("pt-BR");
  if (category) add("UPPER(category) = ?", category);
  const monthFrom = safeText(params.get("monthFrom"), 7);
  if (MONTH_PATTERN.test(monthFrom)) add("entry_date >= ?", `${monthFrom}-01`);
  const monthTo = safeText(params.get("monthTo"), 7);
  if (MONTH_PATTERN.test(monthTo)) add("entry_date <= ?", `${monthTo}-31`);
  const search = safeText(params.get("search"), 120);
  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(product ILIKE ?${values.length} OR reason ILIKE ?${values.length} OR responsible_name ILIKE ?${values.length})`,
    );
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM finance_replacement_entries
         ${whereSql} ORDER BY entry_date DESC, created_at DESC LIMIT 1000`,
      )
      .bind(...values)
      .all<Row>();
    const bySector = await database
      .prepare(
        `SELECT sector, kind, COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS totalCents
         FROM finance_replacement_entries ${whereSql}
         GROUP BY sector, kind`,
      )
      .bind(...values)
      .all<Row>();
    // Painel do período: SALDO MÊS ANTERIOR + ENTRADAS − SAÍDAS = SALDO, por
    // conta de responsável (segue só o filtro de responsável e o período).
    // ponytail: lê todos os lançamentos (só 4 colunas) e soma no código; paginar por mês se passar de dezenas de milhares.
    const [allEntries, balanceRows, responsibles, categories, closedMonths] = await Promise.all([
      database
        .prepare("SELECT entry_date AS entryDate, amount_cents AS amountCents, kind, responsible_name AS responsibleName FROM finance_replacement_entries")
        .all<BalanceEntry>(),
      database
        .prepare(
          `SELECT kind, month, responsible_name AS responsibleName, amount_cents AS amountCents, created_by_name AS createdByName, created_at AS createdAt
           FROM finance_replacement_balances ORDER BY month`,
        )
        .all<BalanceRow & { createdByName: string; createdAt: string }>(),
      database
        .prepare("SELECT DISTINCT responsible_name AS name FROM finance_replacement_entries WHERE responsible_name <> '' ORDER BY responsible_name")
        .all<{ name: string }>(),
      database
        .prepare("SELECT DISTINCT category AS name FROM finance_replacement_entries WHERE category <> '' ORDER BY category")
        .all<{ name: string }>(),
      closedReplacementMonths(database),
    ]);
    const balances = balanceRows.results ?? [];
    const { total, accounts } = replacementBalances(
      allEntries.results ?? [],
      balances,
      MONTH_PATTERN.test(monthFrom) ? monthFrom : "0000-01",
      MONTH_PATTERN.test(monthTo) ? monthTo : "9999-12",
      responsible,
    );
    const list = rows.results ?? [];
    const repeated = repeatedEntryIds(list as Array<BalanceEntry & { id: string }>);
    return jsonResponse({
      rows: list.map((row) => ({ ...row, repeated: repeated.has(String(row.id)) })),
      breakdown: bySector.results ?? [],
      balance: total,
      accounts,
      initialBalances: balances.filter((row) => row.kind === "initial"),
      closedMonths: [...closedMonths].sort(),
      responsibles: (responsibles.results ?? []).map((row) => row.name),
      categories: (categories.results ?? []).map((row) => row.name),
    });
  } catch (error) {
    console.error("Não foi possível carregar o controle de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CONTROLE DE REPOSIÇÃO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR NO CONTROLE DE REPOSIÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const parsed = parseReplacementEntry(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { entryDate, companyId, companyName, product, reason, sector, responsibleName, kind, notes, amountCents, category, financeItemId } = parsed;

    const database = await getD1();
    const who = actor.displayName || "Administrador";
    const closed = await closedReplacementMonths(database);
    if (closed.has(entryDate.slice(0, 7))) return jsonResponse({ error: closedMonthError(entryDate.slice(0, 7)) }, 409);

    if (editId) {
      const existing = await database
        .prepare("SELECT id, entry_date AS entryDate FROM finance_replacement_entries WHERE id=?1")
        .bind(editId)
        .first<{ id: string; entryDate: string }>();
      if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
      if (closed.has(existing.entryDate.slice(0, 7))) {
        return jsonResponse({ error: closedMonthError(existing.entryDate.slice(0, 7)) }, 409);
      }
      await database
        .prepare(
          `UPDATE finance_replacement_entries
           SET entry_date=?1, company_id=?2, company_name=?3, product=?4, reason=?5,
               sector=?6, responsible_name=?7, amount_cents=?8, kind=?9, notes=?10,
               updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP,
               category=?14, finance_item_id=?15
           WHERE id=?13`,
        )
        .bind(
          entryDate, companyId, companyName, product, reason, sector, responsibleName,
          amountCents, kind, notes, actor.id, who, editId, category, financeItemId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const [sql, values] = insertReplacementStatement(parsed, { id: actor.id, name: who });
    await database.prepare(sql).bind(...values).run();
    const id = values[0] as string;
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o lançamento de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LANÇAMENTO." }, 500);
  }
}

// Vincula (ou desvincula) o lançamento a uma Despesa já criada pelo front.
export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O CONTROLE DE REPOSIÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const expenseId = safeText(body.expenseId, 80);
    // Categoria financeira escolhida ao virar despesa fica gravada no lançamento.
    const financeItemId = safeText(body.financeItemId, 80);
    if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, kind, entry_date AS entryDate, expense_id AS expenseId, finance_item_id AS financeItemId FROM finance_replacement_entries WHERE id=?1")
      .bind(id)
      .first<{ id: string; kind: string; entryDate: string; expenseId: string; financeItemId: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
    if (expenseId && !EXPENSE_ELIGIBLE_KINDS.has(existing.kind)) {
      return jsonResponse(
        { error: "SÓ LANÇAMENTOS DE SAÍDA DE DINHEIRO PODEM VIRAR DESPESA." },
        400,
      );
    }
    // 27/11/2026: a despesa da reposição já nasce PAGA (o dinheiro saiu da conta
    // do responsável na data do lançamento) — some do Contas a Pagar e do Fluxo
    // de Caixa futuro; fica em Despesas e na DRE.
    const statements: [string, unknown[]][] = [[
      `UPDATE finance_replacement_entries
       SET expense_id=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP, finance_item_id=?5
       WHERE id=?4`,
      [expenseId, actor.id, actor.displayName || "Administrador", id, financeItemId || existing.financeItemId],
    ]];
    if (expenseId) {
      const payables = await database
        .prepare("SELECT id FROM accounts_payable WHERE expense_id=?1 AND status <> 'canceled' AND paid_amount_cents < original_amount_cents")
        .bind(expenseId)
        .all<{ id: string }>();
      for (const { id: payableId } of payables.results ?? []) {
        const payable = await loadPayable(database, payableId);
        if (!payable) continue;
        const payment = await planPayablePayment(database, payable, actor, {
          idempotencyKey: `reposicao-pago:${payableId}`,
          amountCents: payable.originalAmountCents - payable.paidAmountCents,
          paymentDate: existing.entryDate,
          scheduled: false,
          paymentMethod: "CONTROLE DE REPOSIÇÃO",
          financeAccountId: "",
          notes: "PAGO PELO RESPONSÁVEL (CONTROLE DE REPOSIÇÃO).",
        });
        if ("error" in payment) return jsonResponse({ error: payment.error }, payment.status);
        statements.push(...payment.statements);
      }
    }
    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ updated: true, id, expenseId });
  } catch (error) {
    console.error("Não foi possível vincular a despesa ao lançamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL VINCULAR A DESPESA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR LANÇAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const params = new URL(request.url).searchParams;
  const id = safeText(params.get("id"), 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, entry_date AS entryDate, expense_id AS expenseId FROM finance_replacement_entries WHERE id=?1")
      .bind(id)
      .first<{ id: string; entryDate: string; expenseId: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
    if ((await closedReplacementMonths(database)).has(existing.entryDate.slice(0, 7))) {
      return jsonResponse({ error: closedMonthError(existing.entryDate.slice(0, 7)) }, 409);
    }
    // withExpense=1: exclui também a despesa vinculada; sem ele, a despesa fica.
    const plan = await planReplacementDelete(database, existing, params.get("withExpense") === "1",
      { id: actor.id, name: actor.displayName || "Administrador" });
    if ("skip" in plan) return jsonResponse({ error: plan.skip }, 409);
    await database.batch(plan.statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ deleted: true, expenseDeleted: Boolean(existing.expenseId && params.get("withExpense") === "1") });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO." }, 500);
  }
}
