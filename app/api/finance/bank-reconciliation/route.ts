import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { normalizeMerchantKey, suggestFromRules, type ClassificationRule } from "../../../lib/bank-reconciliation";
import {
  canManageFinance,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
type RawRow = Record<string, unknown>;

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

type ReconEntry = { id: string; entryDate: string; amountCents: number; status: string; payableId: string; expenseId: string; paymentId: string };
type Database = Awaited<ReturnType<typeof getD1>>;

const SUGGEST_DAYS = 7;
function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * CONTAS A PAGAR parecidas com cada SAÍDA ainda aberta do extrato: mesmo
 * valor em aberto e vencimento até 7 dias antes/depois (a mais próxima da
 * data do extrato). Só sugestão — quem baixa é o usuário.
 */
async function suggestPayables(database: Database, entries: ReconEntry[]) {
  const open = entries.filter(
    (entry) => entry.amountCents < 0 && !entry.payableId && !entry.expenseId && (entry.status === "pending" || entry.status === "classified"),
  );
  const result = new Map<string, Record<string, unknown>>();
  if (!open.length) return result;
  const amounts = [...new Set(open.map((entry) => -entry.amountCents))].slice(0, 400);
  const dates = open.map((entry) => entry.entryDate).sort();
  const candidates = await database
    .prepare(
      `SELECT p.id, p.description, p.due_date AS dueDate, p.company_name AS companyName,
              p.original_amount_cents - p.paid_amount_cents AS openCents, COALESCE(s.name, '') AS supplierName
       FROM accounts_payable p LEFT JOIN finance_suppliers s ON s.id = p.supplier_id
       WHERE p.status <> 'paid' AND p.status <> 'canceled'
         AND p.due_date >= ?1 AND p.due_date <= ?2
         AND (p.original_amount_cents - p.paid_amount_cents) IN (${amounts.map((_, index) => `?${index + 3}`).join(",")})`,
    )
    .bind(shiftDate(dates[0], -SUGGEST_DAYS), shiftDate(dates[dates.length - 1], SUGGEST_DAYS), ...amounts)
    .all<{ id: string; description: string; dueDate: string; companyName: string; openCents: number; supplierName: string }>();
  const taken = new Set<string>();
  const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  for (const entry of open) {
    const best = (candidates.results ?? [])
      .filter((row) => Number(row.openCents) === -entry.amountCents && !taken.has(row.id) && dayDiff(row.dueDate, entry.entryDate) <= SUGGEST_DAYS)
      .sort((a, b) => dayDiff(a.dueDate, entry.entryDate) - dayDiff(b.dueDate, entry.entryDate))[0];
    if (best) {
      taken.add(best.id);
      result.set(entry.id, { ...best, openCents: Number(best.openCents) });
    }
  }
  return result;
}

const PAYMENT_SUGGEST_DAYS = 5;

/**
 * PAGAMENTOS já registrados no Contas a Pagar com o mesmo valor de cada SAÍDA
 * ainda aberta do extrato e data até 5 dias antes/depois (o mais próximo).
 * Traz fornecedor, descrição, categoria, unidade e centro de custo para
 * preencher a linha; só sugestão — quem confirma é o usuário. Pagamento já
 * vinculado a outra linha (ou feito pela própria conciliação) não volta.
 */
async function suggestPayments(database: Database, entries: ReconEntry[], financeAccountId: string, companyId: string | null) {
  const open = entries.filter(
    (entry) => entry.amountCents < 0 && !entry.payableId && !entry.expenseId && (entry.status === "pending" || entry.status === "classified"),
  );
  const result = new Map<string, Record<string, unknown>>();
  if (!open.length) return result;
  const amounts = [...new Set(open.map((entry) => -entry.amountCents))].slice(0, 400);
  const dates = open.map((entry) => entry.entryDate).sort();
  const values: unknown[] = [shiftDate(dates[0], -PAYMENT_SUGGEST_DAYS), shiftDate(dates[dates.length - 1], PAYMENT_SUGGEST_DAYS), financeAccountId, ...amounts];
  let companyFilter = "";
  if (companyId !== null) {
    values.push(companyId);
    companyFilter = `AND p.company_id=?${values.length}`;
  }
  const candidates = await database
    .prepare(
      `SELECT pay.id, pay.amount_cents AS amountCents, pay.payment_date AS paymentDate, p.id AS payableId,
              p.description, COALESCE(s.name, '') AS supplierName, p.finance_item_id AS financeItemId,
              COALESCE(p.cost_center_id, '') AS costCenterId, p.company_id AS companyId, p.company_name AS companyName
       FROM accounts_payable_payments pay
       JOIN accounts_payable p ON p.id = pay.payable_id
       LEFT JOIN finance_suppliers s ON s.id = p.supplier_id
       WHERE pay.confirmed_at <> '' AND p.status <> 'canceled'
         AND pay.payment_date >= ?1 AND pay.payment_date <= ?2
         AND (pay.finance_account_id = '' OR pay.finance_account_id = ?3)
         AND pay.idempotency_key NOT LIKE 'bank-entry:%'
         AND pay.amount_cents IN (${amounts.map((_, index) => `?${index + 4}`).join(",")})
         ${companyFilter}
         AND NOT EXISTS (SELECT 1 FROM finance_bank_statement_entries b WHERE b.payment_id = pay.id)`,
    )
    .bind(...values)
    .all<{ id: string; amountCents: number; paymentDate: string; payableId: string; description: string; supplierName: string; financeItemId: string; costCenterId: string; companyId: string; companyName: string }>();
  const taken = new Set<string>();
  const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  // Par (linha, pagamento) mais próximo primeiro: cada um usado uma vez só.
  const pairs = open.flatMap((entry) =>
    (candidates.results ?? [])
      .filter((row) => Number(row.amountCents) === -entry.amountCents && dayDiff(row.paymentDate, entry.entryDate) <= PAYMENT_SUGGEST_DAYS)
      .map((row) => ({ entry, row, diff: dayDiff(row.paymentDate, entry.entryDate) })),
  );
  pairs.sort((a, b) => a.diff - b.diff);
  for (const { entry, row } of pairs) {
    if (taken.has(row.id) || result.has(entry.id)) continue;
    taken.add(row.id);
    result.set(entry.id, { ...row, amountCents: Number(row.amountCents) });
  }
  return result;
}

/**
 * Resumo do período (conta + mês): SALDO INICIAL (o informado na tela, ou o
 * calculado = saldo de abertura da conta + lançamentos do extrato antes do
 * mês), entradas, saídas e saldo final.
 */
async function periodSummary(database: Database, financeAccountId: string, month: string) {
  const start = `${month}-01`;
  const account = await database
    .prepare("SELECT opening_balance_cents AS openingBalanceCents, opening_balance_date AS openingBalanceDate FROM finance_accounts WHERE id=?1")
    .bind(financeAccountId)
    .first<{ openingBalanceCents: number; openingBalanceDate: string }>();
  // Saldo de abertura da conta vale a partir da data dele: soma o extrato desde então.
  const sinceDate = String(account?.openingBalanceDate || "");
  const [stored, before, within] = await Promise.all([
    database
      .prepare("SELECT opening_cents AS openingCents FROM finance_bank_period_balances WHERE finance_account_id=?1 AND month=?2")
      .bind(financeAccountId, month)
      .first<{ openingCents: number }>(),
    database
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM finance_bank_statement_entries
         WHERE finance_account_id=?1 AND entry_date < ?2 AND entry_date >= ?3`,
      )
      .bind(financeAccountId, start, sinceDate)
      .first<{ total: number }>(),
    database
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS inflow,
                COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END), 0) AS outflow
         FROM finance_bank_statement_entries
         WHERE finance_account_id=?1 AND entry_date >= ?2 AND entry_date <= ?3`,
      )
      .bind(financeAccountId, start, `${month}-31`)
      .first<{ inflow: number; outflow: number }>(),
  ]);
  const computed = Number(account?.openingBalanceCents ?? 0) + Number(before?.total ?? 0);
  const openingCents = stored ? Number(stored.openingCents) : computed;
  const inflowCents = Number(within?.inflow ?? 0);
  const outflowCents = Number(within?.outflow ?? 0);
  return {
    month,
    openingCents,
    openingSource: stored ? "informado" : "calculado",
    computedOpeningCents: computed,
    inflowCents,
    outflowCents,
    closingCents: openingCents + inflowCents - outflowCents,
  };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const params = new URL(request.url).searchParams;
  const financeAccountId = safeText(params.get("financeAccountId"), 80);
  const month = safeText(params.get("month"), 7);
  const status = safeText(params.get("status"), 12);
  if (!financeAccountId) return jsonResponse({ error: "SELECIONE A CONTA BANCÁRIA." }, 400);

  try {
    const database = await getD1();
    const account = await database
      .prepare("SELECT company_id AS companyId, name FROM finance_accounts WHERE id=?1")
      .bind(financeAccountId)
      .first<{ companyId: string; name: string }>();
    if (!account) return jsonResponse({ error: "CONTA BANCÁRIA NÃO ENCONTRADA." }, 404);
    if (!allStores && account.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA CONTA." }, 403);
    }

    const conditions = ["finance_account_id=?1"];
    const values: unknown[] = [financeAccountId];
    if (MONTH_PATTERN.test(month)) {
      values.push(`${month}-01`, `${month}-31`);
      conditions.push(`entry_date >= ?2 AND entry_date <= ?3`);
    }
    if (["pending", "classified", "confirmed", "expensed", "credit_sale"].includes(status)) {
      values.push(status);
      conditions.push(`status=?${values.length}`);
    }
    const rows = await database
      .prepare(
        `SELECT id, entry_date AS entryDate, description, raw_merchant AS rawMerchant,
                amount_cents AS amountCents, category_item_id AS categoryItemId, subcategory,
                cost_center_id AS costCenterId, company_id AS companyId, in_dre AS inDre,
                in_rateio AS inRateio, status, expense_id AS expenseId,
                activity_id AS activityId, payable_id AS payableId, payment_id AS paymentId
         FROM finance_bank_statement_entries
         WHERE ${conditions.join(" AND ")}
         ORDER BY entry_date DESC, id ASC
         LIMIT 3000`,
      )
      .bind(...values)
      .all<ReconEntry>();
    const entries = (rows.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
    const suggestions = await suggestPayables(database, entries);
    const paymentSuggestions = await suggestPayments(database, entries, financeAccountId, allStores ? null : account.companyId);
    const period = MONTH_PATTERN.test(month) ? await periodSummary(database, financeAccountId, month) : null;

    return jsonResponse({
      accountName: account.name,
      entries: entries.map((entry) => ({ ...entry, payableSuggestion: suggestions.get(entry.id) ?? null, paymentSuggestion: paymentSuggestions.get(entry.id) ?? null })),
      period,
    });
  } catch (error) {
    console.error("Não foi possível carregar a conciliação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A CONCILIAÇÃO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA IMPORTAR EXTRATOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const financeAccountId = safeText(body.financeAccountId, 80);
    const sourceName = safeText(body.sourceName, 200);
    const sourceFormatRaw = safeText(body.sourceFormat, 8).toLowerCase();
    const sourceFormat = ["ofx", "xls", "xlsx", "csv", "pdf"].includes(sourceFormatRaw) ? sourceFormatRaw : "csv";
    const rawRows = Array.isArray(body.rows) ? (body.rows as RawRow[]) : [];
    if (!financeAccountId) return jsonResponse({ error: "SELECIONE A CONTA BANCÁRIA." }, 400);
    if (!rawRows.length) return jsonResponse({ error: "O EXTRATO NÃO TEM LANÇAMENTOS." }, 400);
    if (rawRows.length > 5000) return jsonResponse({ error: "EXTRATO GRANDE DEMAIS (MÁX. 5000 LINHAS)." }, 400);

    const database = await getD1();
    const account = await database
      .prepare("SELECT company_id AS companyId FROM finance_accounts WHERE id=?1")
      .bind(financeAccountId)
      .first<{ companyId: string }>();
    if (!account) return jsonResponse({ error: "CONTA BANCÁRIA NÃO ENCONTRADA." }, 404);
    if (!allStores && account.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA CONTA." }, 403);
    }
    const companyId = account.companyId;

    // Regras aprendidas para a loja da conta (+ globais).
    const rulesRows = await database
      .prepare(
        `SELECT merchant_key AS merchantKey, category_item_id AS categoryItemId,
                subcategory, cost_center_id AS costCenterId, in_dre AS inDre,
                in_rateio AS inRateio, hits
         FROM finance_bank_classification_rules
         WHERE company_id='' OR company_id=?1`,
      )
      .bind(companyId)
      .all<ClassificationRule>();
    const rules = rulesRows.results ?? [];

    const who = actor.displayName || "Administrador";
    const importId = crypto.randomUUID();
    let inserted = 0;
    let duplicates = 0;
    let suggestedCount = 0;
    let periodStart = "";
    let periodEnd = "";

    for (const raw of rawRows) {
      const entryDate = safeText(raw.entryDate, 10);
      if (!DATE_RE.test(entryDate)) continue;
      const amountCents = Math.round(num(raw.amountCents));
      if (amountCents === 0) continue;
      const description = safeText(raw.description, 300);
      const fitId = safeText(raw.fitId, 80);

      // Dedupe: por fit_id quando existe; senão por data+valor+descrição.
      let dup: { id: string } | null = null;
      if (fitId) {
        dup = await database
          .prepare(
            "SELECT id FROM finance_bank_statement_entries WHERE finance_account_id=?1 AND fit_id=?2",
          )
          .bind(financeAccountId, fitId)
          .first<{ id: string }>();
      } else {
        dup = await database
          .prepare(
            `SELECT id FROM finance_bank_statement_entries
             WHERE finance_account_id=?1 AND entry_date=?2 AND amount_cents=?3 AND description=?4`,
          )
          .bind(financeAccountId, entryDate, amountCents, description)
          .first<{ id: string }>();
      }
      if (dup) {
        duplicates += 1;
        continue;
      }

      const merchantKey = normalizeMerchantKey(description);
      const suggestion = suggestFromRules(merchantKey, rules);
      if (suggestion) suggestedCount += 1;

      if (!periodStart || entryDate < periodStart) periodStart = entryDate;
      if (!periodEnd || entryDate > periodEnd) periodEnd = entryDate;

      await database
        .prepare(
          `INSERT INTO finance_bank_statement_entries
            (id, import_id, finance_account_id, company_id, entry_date, description, raw_merchant,
             amount_cents, fit_id, category_item_id, subcategory, cost_center_id, in_dre, in_rateio,
             status, created_by, created_by_name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'pending', ?15, ?16)`,
        )
        .bind(
          crypto.randomUUID(),
          importId,
          financeAccountId,
          companyId,
          entryDate,
          description,
          merchantKey,
          amountCents,
          fitId,
          suggestion ? suggestion.categoryItemId : "",
          suggestion ? suggestion.subcategory : "",
          suggestion ? suggestion.costCenterId : "",
          // Sem regra aprendida, DRE e RATEIO chegam DESMARCADOS (23/10/2026):
          // quem classifica marca conforme a classificação.
          suggestion ? suggestion.inDre : 0,
          suggestion ? suggestion.inRateio : 0,
          actor.id,
          who,
        )
        .run();
      inserted += 1;
    }

    if (!inserted && !duplicates) {
      return jsonResponse({ error: "NENHUM LANÇAMENTO VÁLIDO NO EXTRATO." }, 400);
    }

    await database
      .prepare(
        `INSERT INTO finance_bank_statement_imports
          (id, finance_account_id, company_id, source_name, source_format, period_start, period_end,
           row_count, duplicate_count, created_by, created_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        importId,
        financeAccountId,
        companyId,
        sourceName,
        sourceFormat,
        periodStart,
        periodEnd,
        inserted,
        duplicates,
        actor.id,
        who,
      )
      .run();

    return jsonResponse({ imported: true, importId, inserted, duplicates, suggestedCount }, 201);
  } catch (error) {
    console.error("Não foi possível importar o extrato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR O EXTRATO." }, 500);
  }
}
