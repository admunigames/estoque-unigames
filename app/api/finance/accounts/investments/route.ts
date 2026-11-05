import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";

// INVESTIMENTOS dentro de uma conta já cadastrada (04/11/2026): aplicações e
// resgates. GET ?accountId → lançamentos + saldo investido; GET ?until=AAAA-MM-DD
// → saldo investido de cada conta até a data (Caixa Semanal). POST cria;
// DELETE ?id exclui.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED = "SUM(CASE WHEN kind='resgate' THEN -amount_cents ELSE amount_cents END)";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManageFinance(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  const url = new URL(request.url);
  const accountId = safeText(url.searchParams.get("accountId"), 80);
  const until = safeText(url.searchParams.get("until"), 10);
  try {
    const database = await getD1();
    if (until) {
      if (!DATE.test(until)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
      const rows = await database
        .prepare(`SELECT account_id AS accountId, COALESCE(${SIGNED}, 0) AS investedCents FROM finance_account_investments WHERE entry_date <= ?1 GROUP BY account_id`)
        .bind(until)
        .all<{ accountId: string; investedCents: number }>();
      return jsonResponse({ until, balances: (rows.results ?? []).map((row) => ({ ...row, investedCents: Number(row.investedCents) })) });
    }
    if (!accountId) return jsonResponse({ error: "SELECIONE A CONTA." }, 400);
    const rows = await database
      .prepare(
        `SELECT id, account_id AS accountId, kind, entry_date AS entryDate, amount_cents AS amountCents, description,
                created_by_name AS createdByName
         FROM finance_account_investments WHERE account_id=?1 ORDER BY entry_date DESC, created_at DESC`,
      )
      .bind(accountId)
      .all<{ kind: string; amountCents: number }>();
    const entries = rows.results ?? [];
    const investedCents = entries.reduce((sum, row) => sum + (row.kind === "resgate" ? -1 : 1) * Number(row.amountCents), 0);
    return jsonResponse({ accountId, entries, investedCents });
  } catch (error) {
    console.error("Não foi possível carregar os investimentos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS INVESTIMENTOS." }, 500);
  }
}

/** { accountId, kind: 'aplicacao'|'resgate', entryDate, amountCents, description } */
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O FINANCEIRO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const accountId = safeText(body.accountId, 80);
    const kind = safeText(body.kind, 20);
    const entryDate = safeText(body.entryDate, 10);
    const amountCents = Number(body.amountCents);
    const description = safeText(body.description, 200);
    if (kind !== "aplicacao" && kind !== "resgate") return jsonResponse({ error: "ESCOLHA APLICAÇÃO OU RESGATE." }, 400);
    if (!DATE.test(entryDate)) return jsonResponse({ error: "INFORME A DATA." }, 400);
    if (!Number.isInteger(amountCents) || amountCents <= 0) return jsonResponse({ error: "INFORME O VALOR." }, 400);
    const database = await getD1();
    const account = await database.prepare("SELECT id FROM finance_accounts WHERE id=?1").bind(accountId).first<{ id: string }>();
    if (!account) return jsonResponse({ error: "CONTA FINANCEIRA NÃO ENCONTRADA." }, 404);
    if (kind === "resgate") {
      const row = await database
        .prepare(`SELECT COALESCE(${SIGNED}, 0) AS invested FROM finance_account_investments WHERE account_id=?1 AND entry_date <= ?2`)
        .bind(accountId, entryDate)
        .first<{ invested: number }>();
      if (amountCents > Number(row?.invested ?? 0)) return jsonResponse({ error: "O RESGATE É MAIOR QUE O SALDO INVESTIDO NA DATA." }, 409);
    }
    const id = crypto.randomUUID();
    const who = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO finance_account_investments
          (id, account_id, kind, entry_date, amount_cents, description, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)`,
      )
      .bind(id, accountId, kind, entryDate, amountCents, description, actor.id, who)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível gravar o investimento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR O INVESTIMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManageFinance(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O FINANCEIRO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM finance_account_investments WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o investimento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O INVESTIMENTO." }, 500);
  }
}
