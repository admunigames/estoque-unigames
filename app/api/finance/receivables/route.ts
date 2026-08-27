import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { todayInTimezone } from "../../../lib/finance-status";
import { DATE_PATTERN } from "../../../lib/payables-recurrence";
import { isReceivableStatus, receivableStatusCaseSql } from "../../../lib/receivables-status";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import { loadEffectiveCashFlowSettings } from "../cash-flow-settings/shared";
import { parseReceived, resolveReceivableOperator } from "./shared";

type ListRow = Record<string, unknown>;

const SORTABLE_COLUMNS: Record<string, string> = {
  expectedDate: "expected_date",
  competenceMonth: "competence_month",
  operatorText: "operator_text",
  expectedAmountCents: "expected_amount_cents",
  receivedAmountCents: "received_amount_cents",
  createdAt: "created_at",
};

// Recebíveis (Financeiro Fase 6). Mesma permissão do resto do Financeiro
// (finance:manage) e mesmo escopo por loja — não há permissão nova.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const params = new URL(request.url).searchParams;
  const companyId = safeText(params.get("companyId"), 80);
  if (!allStores && companyId && companyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? companyId : scopeActor.companyId;
  const today = todayInTimezone();

  const conditions: string[] = [];
  const values: unknown[] = [];
  function addCondition(sqlFragment: string, ...args: unknown[]) {
    let fragment = sqlFragment;
    for (const arg of args) {
      values.push(arg);
      fragment = fragment.replace("?", `?${values.length}`);
    }
    conditions.push(fragment);
  }

  if (effectiveCompanyId) addCondition("company_id = ?", effectiveCompanyId);

  const competenceFrom = safeText(params.get("competenceFrom"), 7);
  const competenceTo = safeText(params.get("competenceTo"), 7);
  if (MONTH_PATTERN.test(competenceFrom)) addCondition("competence_month >= ?", competenceFrom);
  if (MONTH_PATTERN.test(competenceTo)) addCondition("competence_month <= ?", competenceTo);

  const expectedFrom = safeText(params.get("expectedFrom"), 10);
  const expectedTo = safeText(params.get("expectedTo"), 10);
  if (DATE_PATTERN.test(expectedFrom)) addCondition("expected_date >= ?", expectedFrom);
  if (DATE_PATTERN.test(expectedTo)) addCondition("expected_date <= ?", expectedTo);

  const operatorText = safeText(params.get("operatorText"), 120);
  if (operatorText) addCondition("operator_text ILIKE ?", `%${operatorText}%`);

  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get("pageSize")) || 20));
  const sortField = SORTABLE_COLUMNS[params.get("sort") || ""] || "expected_date";
  const sortDirection = params.get("dir") === "desc" ? "DESC" : "ASC";

  try {
    const database = await getD1();
    const settings = await loadEffectiveCashFlowSettings(database, effectiveCompanyId);

    // Os três parâmetros do CASE de status entram SEMPRE (mesmo sem filtro de
    // status), porque o SELECT das linhas usa a expressão. A condição neutra
    // com cast explícito garante que as duas queries (totais e linhas) fiquem
    // com a mesma contagem de binds — mesma técnica de payables/route.ts.
    values.push(today, settings.receivablesToleranceBps, settings.receivablesToleranceFixedCents);
    const todayIndex = values.length - 2;
    const bpsIndex = values.length - 1;
    const fixedIndex = values.length;
    const statusSql = receivableStatusCaseSql(todayIndex, bpsIndex, fixedIndex);
    conditions.push(`?${todayIndex}::text IS NOT NULL`);
    conditions.push(`?${bpsIndex}::int IS NOT NULL`);
    conditions.push(`?${fixedIndex}::int IS NOT NULL`);

    const status = safeText(params.get("status"), 24);
    if (status && isReceivableStatus(status)) {
      values.push(status);
      conditions.push(`${statusSql} = ?${values.length}`);
    } else if (params.get("includeCanceled") !== "1") {
      // Cancelados só aparecem quando pedidos explicitamente (pelo filtro de
      // status ou por includeCanceled) — igual ao comportamento das telas de
      // Contas a Pagar.
      conditions.push("canceled = 0");
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const totalsRow = await database
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(expected_amount_cents), 0) AS expectedCents,
                COALESCE(SUM(COALESCE(received_amount_cents, 0)), 0) AS receivedCents,
                COALESCE(SUM(CASE WHEN received_amount_cents IS NULL THEN 0
                                  ELSE received_amount_cents - expected_amount_cents END), 0) AS differenceCents,
                COALESCE(SUM(CASE WHEN received_amount_cents IS NULL THEN expected_amount_cents ELSE 0 END), 0) AS pendingCents
         FROM accounts_receivable ${whereSql}`,
      )
      .bind(...values)
      .first<{
        count: number;
        expectedCents: number;
        receivedCents: number;
        differenceCents: number;
        pendingCents: number;
      }>();

    const rowsValues = [...values, pageSize, (page - 1) * pageSize];
    const rows = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName, operator_text AS operatorText,
                acquirer_id AS acquirerId,
                competence_month AS competenceMonth, expected_date AS expectedDate,
                expected_amount_cents AS expectedAmountCents, received_amount_cents AS receivedAmountCents,
                received_date AS receivedDate, notes, canceled,
                CASE WHEN received_amount_cents IS NULL THEN NULL
                     ELSE received_amount_cents - expected_amount_cents END AS differenceCents,
                ${statusSql} AS displayStatus,
                created_at AS createdAt, updated_at AS updatedAt
         FROM accounts_receivable
         ${whereSql}
         ORDER BY ${sortField} ${sortDirection}, id ASC
         LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
      )
      .bind(...rowsValues)
      .all<ListRow>();

    return jsonResponse({
      rows: rows.results ?? [],
      page,
      pageSize,
      total: Number(totalsRow?.count ?? 0),
      totals: {
        count: Number(totalsRow?.count ?? 0),
        expectedCents: Number(totalsRow?.expectedCents ?? 0),
        receivedCents: Number(totalsRow?.receivedCents ?? 0),
        differenceCents: Number(totalsRow?.differenceCents ?? 0),
        pendingCents: Number(totalsRow?.pendingCents ?? 0),
      },
      settings,
      today,
    });
  } catch (error) {
    console.error("Não foi possível carregar os recebíveis.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS RECEBÍVEIS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR RECEBÍVEIS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const requestedCompanyId = safeText(body.companyId, 80);
    const companyId = allStores ? requestedCompanyId : scopeActor.companyId;
    if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
    }
    if (!companyId) return jsonResponse({ error: "SELECIONE A UNIDADE." }, 400);

    const competenceMonth = safeText(body.competenceMonth, 7);
    const expectedDate = safeText(body.expectedDate, 10);
    const notes = safeText(body.notes, 500);
    const expectedAmountCents = Math.round(Number(body.expectedAmountCents));

    if (!MONTH_PATTERN.test(competenceMonth)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }
    if (!DATE_PATTERN.test(expectedDate)) {
      return jsonResponse({ error: "INFORME UMA DATA PREVISTA VÁLIDA." }, 400);
    }
    if (!Number.isFinite(expectedAmountCents) || expectedAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR PREVISTO MAIOR QUE ZERO." }, 400);
    }

    // Recebimento já pode vir preenchido na criação (lançamento retroativo).
    const receivedParsed = parseReceived(body);
    if (receivedParsed.error) return jsonResponse({ error: receivedParsed.error }, 400);

    const database = await getD1();
    const companies = await loadCompanyList(database);
    const company = companies.find((item) => item.id === companyId);
    if (!company) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);

    const operator = await resolveReceivableOperator(database, body, companyId);
    if (operator.error) return jsonResponse({ error: operator.error }, 400);
    const { operatorText } = operator;

    const idempotencyKey =
      safeText(body.idempotencyKey, 120) ||
      `receivable:${companyId}:${competenceMonth}:${expectedDate}:${operatorText}:${expectedAmountCents}:${crypto.randomUUID()}`;
    const existing = await database
      .prepare("SELECT id FROM accounts_receivable WHERE idempotency_key=?1")
      .bind(idempotencyKey)
      .first<{ id: string }>();
    if (existing) return jsonResponse({ created: true, alreadyProcessed: true, id: existing.id });

    const id = crypto.randomUUID();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO accounts_receivable
          (id, company_id, company_name, operator_text, acquirer_id, competence_month, expected_date,
           expected_amount_cents, received_amount_cents, received_date, notes, canceled, idempotency_key,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?14, CURRENT_TIMESTAMP, ?13, ?14, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        companyId,
        company.name,
        operatorText,
        operator.acquirerId,
        competenceMonth,
        expectedDate,
        expectedAmountCents,
        receivedParsed.receivedAmountCents,
        receivedParsed.receivedDate,
        notes,
        idempotencyKey,
        actor.id,
        actorName,
      )
      .run();

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o recebível.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O RECEBÍVEL." }, 500);
  }
}
