import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { addDays, todayInTimezone } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, loadCompanyList, safeText, sameOrigin, type JsonMap } from "../../shared";
import { assertFinanceAccountBelongsToCompany } from "../../payables/shared";
import { loadExpectedCardDeposits } from "../../sales-recon/shared";
import { resolveCashFlowScope } from "../shared";

// IMPORTAR RECEBIMENTOS PREVISTOS (Fluxo de Caixa, 23/10/2026): as parcelas
// das vendas no cartão (arquivo de vendas já importado em Conciliação de
// Vendas) que caem no banco de hoje em diante viram recebíveis — um por
// loja + adquirente + dia de depósito + mês da venda — na conta escolhida.
// Assim a PROJEÇÃO DE PAGAMENTOS bate os pagamentos cadastrados do período
// com os recebimentos previstos.
//
// GET  ?from&to&companyId  → prévia (nada é gravado)
// POST {from, to, companyId, financeAccountId} → grava. Reimportar o mesmo
//      período atualiza o valor/conta dos recebíveis ainda não recebidos
//      (chave card-forecast:...) em vez de duplicar; recebido ou cancelado
//      fica como está.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
type Database = Awaited<ReturnType<typeof getD1>>;

type ForecastLine = {
  key: string;
  companyId: string;
  companyName: string;
  acquirerId: string;
  acquirerName: string;
  date: string;
  competenceMonth: string;
  amountCents: number;
  sales: number;
  receivableId: string;
  /** new = vai criar; update = atualiza o previsto; locked = já recebido/cancelado. */
  action: "new" | "update" | "locked";
};

function windowOf(params: { from?: unknown; to?: unknown }, today: string) {
  const rawFrom = safeText(params.from, 10);
  const rawTo = safeText(params.to, 10);
  const from = DATE_RE.test(rawFrom) && rawFrom > today ? rawFrom : today;
  let to = DATE_RE.test(rawTo) ? rawTo : addDays(today, 89);
  if (to > addDays(today, 364)) to = addDays(today, 364);
  if (to < from) to = from;
  return { from, to };
}

async function buildForecast(database: Database, input: { from: string; to: string; companyId: string }) {
  const [{ acquirers, expected }, companies] = await Promise.all([
    loadExpectedCardDeposits(database, input),
    loadCompanyList(database),
  ]);
  const acquirerName = new Map(acquirers.map((row) => [row.id, row.name]));
  const companyName = new Map(companies.map((row) => [row.id, row.name]));
  const groups = new Map<string, ForecastLine>();
  for (const line of expected) {
    if (!line.companyId || line.netCents <= 0) continue;
    const competenceMonth = line.saleDate.slice(0, 7);
    const key = `card-forecast:${line.companyId}:${line.acquirerId}:${line.date}:${competenceMonth}`;
    const group = groups.get(key) ?? {
      key,
      companyId: line.companyId,
      companyName: companyName.get(line.companyId) ?? "",
      acquirerId: line.acquirerId,
      acquirerName: acquirerName.get(line.acquirerId) ?? "",
      date: line.date,
      competenceMonth,
      amountCents: 0,
      sales: 0,
      receivableId: "",
      action: "new" as const,
    };
    group.amountCents += line.netCents;
    group.sales += 1;
    groups.set(key, group);
  }
  const lines = [...groups.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.acquirerName.localeCompare(b.acquirerName) || a.companyName.localeCompare(b.companyName),
  );
  // Recebíveis que já vieram de uma importação anterior (mesma chave).
  if (lines.length) {
    const existing = await database
      .prepare(
        `SELECT id, idempotency_key AS idempotencyKey, canceled, received_amount_cents AS receivedAmountCents
         FROM accounts_receivable
         WHERE idempotency_key LIKE 'card-forecast:%' AND expected_date >= ?1 AND expected_date <= ?2`,
      )
      .bind(input.from, input.to)
      .all<{ id: string; idempotencyKey: string; canceled: number; receivedAmountCents: number | null }>();
    const byKey = new Map((existing.results ?? []).map((row) => [row.idempotencyKey, row]));
    for (const line of lines) {
      const row = byKey.get(line.key);
      if (!row) continue;
      line.receivableId = row.id;
      line.action = Number(row.canceled) === 1 || (row.receivedAmountCents !== null && row.receivedAmountCents !== undefined) ? "locked" : "update";
    }
  }
  return lines;
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
  const today = todayInTimezone();
  const { from, to } = windowOf({ from: params.get("from"), to: params.get("to") }, today);
  try {
    const database = await getD1();
    const lines = await buildForecast(database, { from, to, companyId: scope.companyId });
    return jsonResponse({ today, from, to, lines });
  } catch (error) {
    console.error("Não foi possível montar os recebimentos previstos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR OS RECEBIMENTOS PREVISTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const actor = checked.actor;
  try {
    const body = (await request.json()) as JsonMap;
    const scope = resolveCashFlowScope(request, safeText(body.companyId, 80));
    if (scope.error) return scope.error;
    const today = todayInTimezone();
    const { from, to } = windowOf(body, today);
    const financeAccountId = safeText(body.financeAccountId, 80);
    if (!financeAccountId) return jsonResponse({ error: "ESCOLHA A CONTA ONDE OS RECEBIMENTOS CAEM." }, 400);
    const database = await getD1();
    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId);
    if (accountError) return jsonResponse({ error: accountError }, 400);

    const lines = await buildForecast(database, { from, to, companyId: scope.companyId });
    const actorName = actor.displayName || "Administrador";
    const statements = [];
    let created = 0;
    let updated = 0;
    let locked = 0;
    for (const line of lines) {
      if (line.action === "locked") {
        locked += 1;
        continue;
      }
      if (line.action === "update") {
        updated += 1;
        statements.push(
          database
            .prepare(
              `UPDATE accounts_receivable
               SET expected_amount_cents=?1, finance_account_id=?2, company_name=?3, operator_text=?4,
                   updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
               WHERE id=?7 AND canceled = 0 AND received_amount_cents IS NULL`,
            )
            .bind(line.amountCents, financeAccountId, line.companyName, line.acquirerName, actor.id, actorName, line.receivableId),
        );
        continue;
      }
      created += 1;
      statements.push(
        database
          .prepare(
            `INSERT INTO accounts_receivable
              (id, company_id, company_name, operator_text, acquirer_id, competence_month, expected_date,
               expected_amount_cents, received_amount_cents, received_date, notes, canceled, idempotency_key,
               created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, finance_account_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '', ?9, 0, ?10, ?11, ?12, CURRENT_TIMESTAMP, ?11, ?12, CURRENT_TIMESTAMP, ?13)`,
          )
          .bind(
            crypto.randomUUID(),
            line.companyId,
            line.companyName,
            line.acquirerName,
            line.acquirerId,
            line.competenceMonth,
            line.date,
            line.amountCents,
            `PREVISTO DAS VENDAS NO CARTÃO (${line.sales} VENDA(S))`,
            line.key,
            actor.id,
            actorName,
            financeAccountId,
          ),
      );
    }
    if (statements.length) await database.batch(statements);
    return jsonResponse({ from, to, created, updated, locked, totalCents: lines.reduce((sum, line) => sum + (line.action === "locked" ? 0 : line.amountCents), 0) });
  } catch (error) {
    console.error("Não foi possível importar os recebimentos previstos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR OS RECEBIMENTOS PREVISTOS." }, 500);
  }
}
