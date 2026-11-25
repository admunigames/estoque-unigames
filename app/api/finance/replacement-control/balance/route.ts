import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { replacementBalances, type BalanceEntry, type BalanceRow } from "../../../../lib/replacement-balance";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";

// Saldos do CONTROLE DE REPOSIÇÃO por conta de responsável (23/11/2026):
// - { action: 'initial', responsibleName, month, amountCents } → SALDO INICIAL
//   da conta, vale a partir do mês (gravar de novo substitui o anterior — é o
//   EDITAR da tela);
// - { action: 'delete_initial', responsibleName, month } → EXCLUI o saldo
//   inicial da conta (25/11/2026);
// - { action: 'close', month } → FINALIZAR MÊS: grava o saldo final de cada
//   conta (vira o SALDO MÊS ANTERIOR do mês seguinte) e trava os lançamentos
//   do mês;
// - { action: 'reopen', month } → REABRIR MÊS (só se nenhum mês depois dele
//   estiver finalizado).

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O CONTROLE DE REPOSIÇÃO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    const month = safeText(body.month, 7);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS." }, 400);
    const database = await getD1();
    const who = actor.displayName || "Administrador";
    const closedMonths = new Set(
      ((await database.prepare("SELECT DISTINCT month FROM finance_replacement_balances WHERE kind='closing'").all<{ month: string }>())
        .results ?? []).map((row) => row.month),
    );

    if (action === "initial") {
      const responsibleName = safeText(body.responsibleName, 160).toLocaleUpperCase("pt-BR");
      if (!responsibleName) return jsonResponse({ error: "INFORME O RESPONSÁVEL (DONO DA CONTA)." }, 400);
      const amountCents = Number(body.amountCents);
      if (!Number.isInteger(amountCents)) return jsonResponse({ error: "INFORME O SALDO INICIAL EM CENTAVOS." }, 400);
      if (closedMonths.has(month)) return jsonResponse({ error: `O MÊS ${monthLabel(month)} ESTÁ FINALIZADO. REABRA O MÊS PARA ALTERAR.` }, 409);
      await database.batch([
        database.prepare("DELETE FROM finance_replacement_balances WHERE kind='initial' AND responsible_name=?1").bind(responsibleName),
        database
          .prepare(
            `INSERT INTO finance_replacement_balances (id, kind, month, responsible_name, amount_cents, created_by, created_by_name, created_at)
             VALUES (?1, 'initial', ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)`,
          )
          .bind(crypto.randomUUID(), month, responsibleName, amountCents, actor.id, who),
      ]);
      return jsonResponse({ saved: true, name: responsibleName, month, amountCents });
    }

    if (action === "delete_initial") {
      const responsibleName = safeText(body.responsibleName, 160).toLocaleUpperCase("pt-BR");
      if (!responsibleName) return jsonResponse({ error: "INFORME O RESPONSÁVEL (DONO DA CONTA)." }, 400);
      if (closedMonths.has(month)) return jsonResponse({ error: `O MÊS ${monthLabel(month)} ESTÁ FINALIZADO. REABRA O MÊS PARA ALTERAR.` }, 409);
      // RETURNING: no Postgres (d1-compat) o "changes" é o número de linhas devolvidas.
      const deleted = await database
        .prepare("DELETE FROM finance_replacement_balances WHERE kind='initial' AND responsible_name=?1 RETURNING id")
        .bind(responsibleName)
        .all<{ id: string }>();
      if (!(deleted.results ?? []).length) return jsonResponse({ error: "SALDO INICIAL NÃO ENCONTRADO. ATUALIZE A TELA." }, 404);
      return jsonResponse({ deleted: true, name: responsibleName, month });
    }

    if (action === "close") {
      if (closedMonths.has(month)) return jsonResponse({ error: `O MÊS ${monthLabel(month)} JÁ ESTÁ FINALIZADO.` }, 409);
      const [entries, balances] = await Promise.all([
        database
          .prepare("SELECT entry_date AS entryDate, amount_cents AS amountCents, kind, responsible_name AS responsibleName FROM finance_replacement_entries")
          .all<BalanceEntry>(),
        database
          .prepare("SELECT kind, month, responsible_name AS responsibleName, amount_cents AS amountCents FROM finance_replacement_balances")
          .all<BalanceRow>(),
      ]);
      const { total, accounts } = replacementBalances(entries.results ?? [], balances.results ?? [], month, month);
      // Conta sem saldo nem movimento até o mês não precisa de fechamento.
      const toClose = accounts.filter((account) => account.openingCents || account.inflowCents || account.outflowCents);
      if (!toClose.length) return jsonResponse({ error: "NENHUM LANÇAMENTO OU SALDO ATÉ ESTE MÊS." }, 400);
      await database.batch(
        toClose.map((account) =>
          database
            .prepare(
              `INSERT INTO finance_replacement_balances
                (id, kind, month, responsible_name, amount_cents, opening_cents, inflow_cents, outflow_cents, created_by, created_by_name, created_at)
               VALUES (?1, 'closing', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)`,
            )
            .bind(
              crypto.randomUUID(), month, account.responsibleName, account.closingCents, account.openingCents,
              account.inflowCents, account.outflowCents, actor.id, who,
            ),
        ),
      );
      return jsonResponse({ closed: true, month, name: `FINALIZOU ${monthLabel(month)}`, balance: total });
    }

    if (action === "reopen") {
      if (!closedMonths.has(month)) return jsonResponse({ error: `O MÊS ${monthLabel(month)} NÃO ESTÁ FINALIZADO.` }, 409);
      const later = [...closedMonths].filter((closed) => closed > month).sort();
      if (later.length) return jsonResponse({ error: `REABRA PRIMEIRO O MÊS ${monthLabel(later[later.length - 1])}.` }, 409);
      await database.prepare("DELETE FROM finance_replacement_balances WHERE kind='closing' AND month=?1").bind(month).run();
      return jsonResponse({ reopened: true, month, name: `REABRIU ${monthLabel(month)}` });
    }

    return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível gravar o saldo do controle de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR O SALDO." }, 500);
  }
}
