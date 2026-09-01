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
    if (["pending", "classified", "confirmed", "expensed"].includes(status)) {
      values.push(status);
      conditions.push(`status=?${values.length}`);
    }
    const rows = await database
      .prepare(
        `SELECT id, entry_date AS entryDate, description, raw_merchant AS rawMerchant,
                amount_cents AS amountCents, category_item_id AS categoryItemId, subcategory,
                cost_center_id AS costCenterId, company_id AS companyId, in_dre AS inDre,
                in_rateio AS inRateio, status, expense_id AS expenseId
         FROM finance_bank_statement_entries
         WHERE ${conditions.join(" AND ")}
         ORDER BY entry_date DESC, id ASC
         LIMIT 3000`,
      )
      .bind(...values)
      .all();

    return jsonResponse({ accountName: account.name, entries: rows.results ?? [] });
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
    const sourceFormat = ["ofx", "xls", "xlsx", "csv"].includes(sourceFormatRaw) ? sourceFormatRaw : "csv";
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
          suggestion ? suggestion.inDre : 1,
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
