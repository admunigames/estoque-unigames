import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { addDays, todayInTimezone } from "../../../../lib/finance-status";
import { suggestReceivableMatches } from "../../../../lib/receivables-recon";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../shared";
import { resolveCashFlowScope } from "../../cash-flow/shared";
import { assertReceivableAccess, loadReceivable } from "../shared";

// CONCILIAÇÃO DE CONTAS A RECEBER (23/10/2026): recebíveis previstos no mês
// × créditos do extrato da conta (Conciliação Bancária). Um recebível
// conciliado guarda o lançamento (bank_entry_id) e vira RECEBIDO pelo valor
// e data do extrato; desfazer volta a pendente.
//
// GET  ?accountId&month           → linhas + sugestões + créditos sem previsto
// POST {action:'link', receivableId, entryId}
//      {action:'unlink', receivableId}
//      {action:'link-suggested', accountId, month} → concilia as sugestões de
//      valor igual (as de valor diferente ficam para conferência manual).

type Database = Awaited<ReturnType<typeof getD1>>;
const WINDOW_DAYS = 5;

type ReceivableRow = {
  id: string;
  companyId: string;
  companyName: string;
  operatorText: string;
  competenceMonth: string;
  expectedDate: string;
  expectedAmountCents: number;
  receivedAmountCents: number | null;
  receivedDate: string;
  financeAccountId: string;
  bankEntryId: string;
};
type CreditRow = { id: string; entryDate: string; description: string; amountCents: number };

function monthRange(month: string) {
  const first = `${month}-01`;
  const [year, index] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const next = index === 12 ? `${year + 1}-01-01` : `${year}-${String(index + 1).padStart(2, "0")}-01`;
  return { first, last: addDays(next, -1) };
}

async function loadRecon(database: Database, input: { accountId: string; month: string; companyId: string; today: string }) {
  const { first, last } = monthRange(input.month);
  const values: unknown[] = [first, last, input.accountId];
  const company = input.companyId ? `AND company_id = ?${values.push(input.companyId)}` : "";
  const [receivables, credits] = await Promise.all([
    database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName, operator_text AS operatorText,
                competence_month AS competenceMonth, expected_date AS expectedDate,
                expected_amount_cents AS expectedAmountCents, received_amount_cents AS receivedAmountCents,
                received_date AS receivedDate, finance_account_id AS financeAccountId, bank_entry_id AS bankEntryId
         FROM accounts_receivable
         WHERE canceled = 0 AND expected_date >= ?1 AND expected_date <= ?2
           AND (finance_account_id = ?3 OR finance_account_id = '') ${company}
         ORDER BY expected_date ASC, operator_text ASC`,
      )
      .bind(...values)
      .all<ReceivableRow>(),
    database
      .prepare(
        `SELECT e.id, e.entry_date AS entryDate, e.description, e.amount_cents AS amountCents
         FROM finance_bank_statement_entries e
         WHERE e.finance_account_id = ?1 AND e.amount_cents > 0 AND e.entry_date >= ?2 AND e.entry_date <= ?3
           AND NOT EXISTS (SELECT 1 FROM accounts_receivable r WHERE r.bank_entry_id = e.id)
         ORDER BY e.entry_date ASC, e.amount_cents DESC`,
      )
      .bind(input.accountId, addDays(first, -WINDOW_DAYS), addDays(last, WINDOW_DAYS))
      .all<CreditRow>(),
  ]);
  const rows = (receivables.results ?? []).map((row) => ({
    ...row,
    expectedAmountCents: Number(row.expectedAmountCents || 0),
    receivedAmountCents: row.receivedAmountCents === null || row.receivedAmountCents === undefined ? null : Number(row.receivedAmountCents),
  }));
  const freeCredits = (credits.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents || 0) }));

  // Lançamentos já ligados (para mostrar data/descrição do extrato).
  const linkedIds = rows.map((row) => row.bankEntryId).filter(Boolean);
  const linked = new Map<string, CreditRow>();
  if (linkedIds.length) {
    const placeholders = linkedIds.map((_, index) => `?${index + 1}`).join(", ");
    const found = await database
      .prepare(`SELECT id, entry_date AS entryDate, description, amount_cents AS amountCents FROM finance_bank_statement_entries WHERE id IN (${placeholders})`)
      .bind(...linkedIds)
      .all<CreditRow>();
    for (const row of found.results ?? []) linked.set(row.id, { ...row, amountCents: Number(row.amountCents || 0) });
  }

  const open = rows.filter((row) => !row.bankEntryId && row.receivedAmountCents === null);
  const suggestions = suggestReceivableMatches(open, freeCredits, WINDOW_DAYS);
  const suggestionOf = new Map(suggestions.map((row) => [row.receivableId, row]));
  const creditById = new Map(freeCredits.map((row) => [row.id, row]));
  const suggestedEntries = new Set(suggestions.map((row) => row.entryId));

  const lines = rows.map((row) => {
    const entry = row.bankEntryId ? linked.get(row.bankEntryId) ?? null : null;
    const suggestion = suggestionOf.get(row.id);
    let status: "ok" | "divergent" | "manual" | "suggested" | "missing" | "awaiting";
    if (row.bankEntryId) status = row.receivedAmountCents === row.expectedAmountCents ? "ok" : "divergent";
    else if (row.receivedAmountCents !== null) status = "manual";
    else if (suggestion) status = "suggested";
    else status = row.expectedDate < input.today ? "missing" : "awaiting";
    return {
      ...row,
      status,
      entry,
      differenceCents: row.receivedAmountCents === null ? null : row.receivedAmountCents - row.expectedAmountCents,
      suggestion: suggestion ? { ...creditById.get(suggestion.entryId)!, exact: suggestion.exact } : null,
    };
  });
  const unmatchedCredits = freeCredits.filter((row) => row.entryDate >= first && row.entryDate <= last && !suggestedEntries.has(row.id));
  const sum = (list: number[]) => list.reduce((total, value) => total + value, 0);
  const totals = {
    expectedCents: sum(lines.map((row) => row.expectedAmountCents)),
    enteredCents: sum(lines.filter((row) => row.bankEntryId).map((row) => row.receivedAmountCents ?? 0)),
    pendingCents: sum(lines.filter((row) => row.receivedAmountCents === null).map((row) => row.expectedAmountCents)),
    missingCents: sum(lines.filter((row) => row.status === "missing").map((row) => row.expectedAmountCents)),
    unmatchedCreditsCents: sum(unmatchedCredits.map((row) => row.amountCents)),
  };
  return { first, last, lines, credits: freeCredits, unmatchedCredits, suggestions, totals };
}

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403) };
  }
  return { actor };
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const params = new URL(request.url).searchParams;
  const scope = resolveCashFlowScope(request, safeText(params.get("companyId"), 80));
  if (scope.error) return scope.error;
  const accountId = safeText(params.get("accountId"), 80);
  const month = safeText(params.get("month"), 7);
  if (!accountId) return jsonResponse({ error: "ESCOLHA A CONTA." }, 400);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  try {
    const database = await getD1();
    const today = todayInTimezone();
    const data = await loadRecon(database, { accountId, month, companyId: scope.companyId, today });
    return jsonResponse({ accountId, month, today, ...data });
  } catch (error) {
    console.error("Não foi possível carregar a conciliação de contas a receber.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A CONCILIAÇÃO DE CONTAS A RECEBER." }, 500);
  }
}

const LINK_SQL = `UPDATE accounts_receivable
  SET bank_entry_id=?1, received_amount_cents=?2, received_date=?3, finance_account_id=?4,
      updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
  WHERE id=?7 AND canceled = 0`;

export async function POST(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const actor = checked.actor;
  const actorName = actor.displayName || "Administrador";
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 30);
    const database = await getD1();

    if (action === "link-suggested") {
      const scope = resolveCashFlowScope(request, safeText(body.companyId, 80));
      if (scope.error) return scope.error;
      const accountId = safeText(body.accountId, 80);
      const month = safeText(body.month, 7);
      if (!accountId || !MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME A CONTA E O MÊS." }, 400);
      const data = await loadRecon(database, { accountId, month, companyId: scope.companyId, today: todayInTimezone() });
      const creditById = new Map(data.credits.map((row) => [row.id, row]));
      const exact = data.suggestions.filter((row) => row.exact);
      if (exact.length) {
        await database.batch(
          exact.map((row) => {
            const credit = creditById.get(row.entryId)!;
            return database.prepare(LINK_SQL).bind(credit.id, credit.amountCents, credit.entryDate, accountId, actor.id, actorName, row.receivableId);
          }),
        );
      }
      return jsonResponse({ linked: exact.length, skipped: data.suggestions.length - exact.length });
    }

    const receivableId = safeText(body.receivableId, 80);
    const receivable = receivableId ? await loadReceivable(database, receivableId) : null;
    if (!receivable) return jsonResponse({ error: "RECEBÍVEL NÃO ENCONTRADO." }, 404);
    const accessError = assertReceivableAccess(scopeActor, receivable);
    if (accessError) return jsonResponse({ error: accessError }, 403);
    if (Number(receivable.canceled) === 1) return jsonResponse({ error: "ESTE RECEBÍVEL ESTÁ CANCELADO." }, 409);

    if (action === "unlink") {
      if (!receivable.bankEntryId) return jsonResponse({ error: "ESTE RECEBÍVEL NÃO ESTÁ CONCILIADO COM O EXTRATO." }, 409);
      await database
        .prepare(
          `UPDATE accounts_receivable
           SET bank_entry_id='', received_amount_cents=NULL, received_date='',
               updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
           WHERE id=?3`,
        )
        .bind(actor.id, actorName, receivable.id)
        .run();
      return jsonResponse({ unlinked: true });
    }

    if (action === "link") {
      const entryId = safeText(body.entryId, 80);
      const entry = entryId
        ? await database
            .prepare(
              `SELECT id, finance_account_id AS financeAccountId, entry_date AS entryDate, amount_cents AS amountCents
               FROM finance_bank_statement_entries WHERE id=?1`,
            )
            .bind(entryId)
            .first<{ id: string; financeAccountId: string; entryDate: string; amountCents: number }>()
        : null;
      if (!entry) return jsonResponse({ error: "LANÇAMENTO DO EXTRATO NÃO ENCONTRADO." }, 404);
      if (Number(entry.amountCents) <= 0) return jsonResponse({ error: "SÓ CRÉDITOS (ENTRADAS) DO EXTRATO CONCILIAM UM RECEBÍVEL." }, 400);
      const taken = await database
        .prepare("SELECT id FROM accounts_receivable WHERE bank_entry_id=?1 AND id <> ?2")
        .bind(entry.id, receivable.id)
        .first<{ id: string }>();
      if (taken) return jsonResponse({ error: "ESSE CRÉDITO DO EXTRATO JÁ CONCILIOU OUTRO RECEBÍVEL." }, 409);
      await database
        .prepare(LINK_SQL)
        .bind(entry.id, Number(entry.amountCents), entry.entryDate, entry.financeAccountId, actor.id, actorName, receivable.id)
        .run();
      return jsonResponse({ linked: true, differenceCents: Number(entry.amountCents) - Number(receivable.expectedAmountCents) });
    }
    return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível conciliar o recebível.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCILIAR O RECEBÍVEL." }, 500);
  }
}
