import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../shared";

// SALDO INICIAL do período da Conciliação Bancária (conta + mês). PUT
// { financeAccountId, month, openingCents } grava; openingCents null apaga
// (volta ao saldo calculado: abertura da conta + extrato antes do mês).

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR A CONCILIAÇÃO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const financeAccountId = safeText(body.financeAccountId, 80);
    const month = safeText(body.month, 7);
    if (!financeAccountId) return jsonResponse({ error: "SELECIONE A CONTA BANCÁRIA." }, 400);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
    const database = await getD1();
    const account = await database.prepare("SELECT id FROM finance_accounts WHERE id=?1").bind(financeAccountId).first<{ id: string }>();
    if (!account) return jsonResponse({ error: "CONTA BANCÁRIA NÃO ENCONTRADA." }, 404);
    if (body.openingCents === null || body.openingCents === undefined || body.openingCents === "") {
      await database
        .prepare("DELETE FROM finance_bank_period_balances WHERE finance_account_id=?1 AND month=?2")
        .bind(financeAccountId, month)
        .run();
      return jsonResponse({ cleared: true });
    }
    const openingCents = Number(body.openingCents);
    if (!Number.isInteger(openingCents) || Math.abs(openingCents) > 100_000_000_000) {
      return jsonResponse({ error: "SALDO INICIAL INVÁLIDO." }, 400);
    }
    await database
      .prepare(
        `INSERT INTO finance_bank_period_balances (id, finance_account_id, month, opening_cents, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
         ON CONFLICT (finance_account_id, month) DO UPDATE
           SET opening_cents = EXCLUDED.opening_cents, updated_by = EXCLUDED.updated_by,
               updated_by_name = EXCLUDED.updated_by_name, updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(crypto.randomUUID(), financeAccountId, month, openingCents, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ saved: true, openingCents });
  } catch (error) {
    console.error("Não foi possível gravar o saldo inicial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR O SALDO INICIAL." }, 500);
  }
}
