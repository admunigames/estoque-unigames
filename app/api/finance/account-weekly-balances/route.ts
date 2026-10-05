import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { isMonday } from "../../../lib/cash-flow";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { resolveCashFlowScope } from "../cash-flow/shared";

// CAIXA SEMANAL — saldo de cada conta informado toda segunda-feira.
// GET ?from&to&companyId: histórico (com nome da conta/loja).
// PUT { weekDate, rows: [{ accountId, balanceCents, notes }] }: upsert por
// conta/semana numa transação. Se for a semana mais recente da conta, também
// atualiza finance_account_balances (o saldo "atual", fonte única do Caixa
// Atual), sem sobrescrever um saldo atual com data mais nova.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const params = new URL(request.url).searchParams;
  const scope = resolveCashFlowScope(request, safeText(params.get("companyId"), 80));
  if (scope.error) return scope.error;
  const from = safeText(params.get("from"), 10);
  const to = safeText(params.get("to"), 10);

  const values: unknown[] = [];
  const conditions: string[] = [];
  const add = (fragment: string, value: unknown) => {
    values.push(value);
    conditions.push(fragment.replace("?", `?${values.length}`));
  };
  if (scope.companyId) add("w.company_id = ?", scope.companyId);
  if (DATE_RE.test(from)) add("w.week_date >= ?", from);
  if (DATE_RE.test(to)) add("w.week_date <= ?", to);

  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT w.id, w.account_id AS accountId, a.name AS accountName, w.company_id AS companyId,
                a.company_name AS companyName, w.week_date AS weekDate, w.balance_cents AS balanceCents,
                w.notes, w.updated_by_name AS updatedByName, w.updated_at AS updatedAt
         FROM finance_account_weekly_balances w
         LEFT JOIN finance_accounts a ON a.id = w.account_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY w.week_date DESC, a.company_name ASC, a.name ASC LIMIT 2000`,
      )
      .bind(...values)
      .all();
    return jsonResponse({ rows: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os saldos semanais.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS SALDOS SEMANAIS." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA INFORMAR SALDOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scope = resolveCashFlowScope(request, "");
  if (scope.error) return scope.error;

  try {
    const body = (await request.json()) as JsonMap;
    const weekDate = safeText(body.weekDate, 10);
    if (!isMonday(weekDate)) return jsonResponse({ error: "A SEMANA PRECISA SER UMA SEGUNDA-FEIRA (AAAA-MM-DD)." }, 400);
    const rawRows = Array.isArray(body.rows) ? (body.rows as JsonMap[]) : [];
    if (!rawRows.length) return jsonResponse({ error: "INFORME O SALDO DE AO MENOS UMA CONTA." }, 400);
    if (rawRows.length > 300) return jsonResponse({ error: "CONTAS DEMAIS NUM ENVIO (MÁX. 300)." }, 400);

    const database = await getD1();
    const who = actor.displayName || "Administrador";
    const statements: ReturnType<typeof database.prepare>[] = [];
    const seen = new Set<string>();
    for (const raw of rawRows) {
      const accountId = safeText(raw?.accountId, 80);
      const balanceCents = Math.round(Number(raw?.balanceCents));
      if (!accountId || seen.has(accountId)) continue;
      seen.add(accountId);
      // Negativo é legítimo (cheque especial); só o número é validado.
      if (raw.balanceCents === null || raw.balanceCents === "" || !Number.isFinite(balanceCents)) {
        return jsonResponse({ error: "INFORME UM SALDO VÁLIDO PARA CADA CONTA." }, 400);
      }
      const account = await database
        .prepare("SELECT id, company_id AS companyId FROM finance_accounts WHERE id=?1")
        .bind(accountId)
        .first<{ id: string; companyId: string }>();
      if (!account) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);
      if (!scope.allStores && account.companyId !== scope.scopeCompanyId) {
        return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA CONTA." }, 403);
      }
      const notes = safeText(raw.notes, 500);
      statements.push(
        database
          .prepare(
            `INSERT INTO finance_account_weekly_balances
              (id, account_id, company_id, week_date, balance_cents, notes,
               created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)
             ON CONFLICT (account_id, week_date) DO UPDATE
               SET company_id = EXCLUDED.company_id, balance_cents = EXCLUDED.balance_cents,
                   notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by,
                   updated_by_name = EXCLUDED.updated_by_name, updated_at = CURRENT_TIMESTAMP`,
          )
          .bind(crypto.randomUUID(), accountId, account.companyId, weekDate, balanceCents, notes, actor.id, who),
      );
      // Saldo atual: só se esta for a semana mais recente da conta e o saldo
      // atual não tiver data mais nova (WHERE do upsert).
      const newer = await database
        .prepare("SELECT 1 AS found FROM finance_account_weekly_balances WHERE account_id=?1 AND week_date > ?2 LIMIT 1")
        .bind(accountId, weekDate)
        .first<{ found: number }>();
      if (!newer) {
        statements.push(
          database
            .prepare(
              `INSERT INTO finance_account_balances
                (id, account_id, company_id, balance_cents, as_of_date, notes, updated_by, updated_by_name, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
               ON CONFLICT (account_id) DO UPDATE
                 SET company_id = EXCLUDED.company_id, balance_cents = EXCLUDED.balance_cents,
                     as_of_date = EXCLUDED.as_of_date, notes = EXCLUDED.notes,
                     updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE finance_account_balances.as_of_date <= EXCLUDED.as_of_date`,
            )
            .bind(crypto.randomUUID(), accountId, account.companyId, balanceCents, weekDate, notes, actor.id, who),
        );
      }
    }
    if (!statements.length) return jsonResponse({ error: "INFORME O SALDO DE AO MENOS UMA CONTA." }, 400);
    await database.batch(statements);
    return jsonResponse({ saved: seen.size, weekDate });
  } catch (error) {
    console.error("Não foi possível salvar os saldos da semana.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR OS SALDOS. NADA FOI GRAVADO." }, 500);
  }
}
