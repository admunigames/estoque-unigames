import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { nextRechargeDate, parseRechargePeriod, RECHARGE_PERIOD_ERROR } from "../../../../lib/phone-recharges";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runStatements, type Statement } from "../../card-fees/shared";

// Ações em lote nas Recargas de Celulares (Financeiro 8/9): { action, ids, fields }
// - period: ALTERAR PERÍODO (fields.periodDays 30/60/90; próxima = última + período);
// - recharge: REGISTRAR RECARGA EM LOTE (fields.date; fields.amountCents vazio =
//   último valor de cada linha; um evento por linha);
// - activate / deactivate: ATIVAR / DESATIVAR;
// - delete: EXCLUIR (com o histórico, igual à exclusão individual).
// Todos os ids conferidos antes (404); gravação numa transação.

const ACTIONS = ["period", "recharge", "activate", "deactivate", "delete"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Row = { id: string; phoneNumber: string; lastRechargeDate: string; lastAmountCents: number; periodDays: number };

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR RECARGAS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 12);
    if (!ACTIONS.includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA LINHA." }, 400);
    if (ids.length > 1000) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 1000)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const periodDays = action === "period" ? parseRechargePeriod(fields.periodDays) : null;
    if (action === "period" && (!periodDays || fields.periodDays === undefined || fields.periodDays === "")) {
      return jsonResponse({ error: RECHARGE_PERIOD_ERROR }, 400);
    }
    const date = safeText(fields.date, 10);
    const typedAmount = fields.amountCents === undefined || fields.amountCents === null || fields.amountCents === "" ? null : Number(fields.amountCents);
    if (action === "recharge") {
      if (!DATE_PATTERN.test(date)) return jsonResponse({ error: "INFORME A DATA DA RECARGA." }, 400);
      if (typedAmount !== null && (!Number.isInteger(typedAmount) || typedAmount <= 0)) {
        return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
      }
    }

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, phone_number AS phoneNumber, last_recharge_date AS lastRechargeDate,
                last_amount_cents AS lastAmountCents, period_days AS periodDays
         FROM finance_phone_recharges WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...ids)
      .all<Row>();
    const rows = found.results ?? [];
    if (rows.length !== ids.length) return jsonResponse({ error: "ALGUMA LINHA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);

    const who = actor.displayName || "Administrador";
    const statements: Statement[] = [];
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    for (const row of rows) {
      if (action === "delete") {
        statements.push(["DELETE FROM finance_phone_recharge_events WHERE recharge_id=?1", [row.id]]);
        statements.push(["DELETE FROM finance_phone_recharges WHERE id=?1", [row.id]]);
      } else if (action === "activate" || action === "deactivate") {
        statements.push([
          "UPDATE finance_phone_recharges SET active=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4",
          [action === "activate" ? 1 : 0, actor.id, who, row.id],
        ]);
      } else if (action === "period") {
        statements.push([
          `UPDATE finance_phone_recharges SET period_days=?1, next_recharge_date=?2, updated_by=?3, updated_by_name=?4,
             updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
          [periodDays, nextRechargeDate(row.lastRechargeDate, periodDays!), actor.id, who, row.id],
        ]);
      } else {
        const amountCents = typedAmount ?? Number(row.lastAmountCents || 0);
        if (amountCents <= 0) {
          skipped.push({ id: row.id, description: row.phoneNumber, reason: "SEM VALOR (INFORME O VALOR)" });
          continue;
        }
        const period = parseRechargePeriod(row.periodDays) ?? 90;
        statements.push([
          `INSERT INTO finance_phone_recharge_events
             (id, recharge_id, recharge_date, amount_cents, notes, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, 'REGISTRADA EM LOTE', ?5, ?6, CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), row.id, date, amountCents, actor.id, who],
        ]);
        statements.push([
          `UPDATE finance_phone_recharges SET last_recharge_date=?1, last_amount_cents=?2, next_recharge_date=?3,
             updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP WHERE id=?6`,
          [date, amountCents, nextRechargeDate(date, period), actor.id, who, row.id],
        ]);
      }
    }
    await runStatements(database, statements);
    return jsonResponse({ applied: rows.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de recargas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APLICAR O LOTE DE RECARGAS." }, 500);
  }
}
