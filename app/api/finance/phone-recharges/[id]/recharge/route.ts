import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../../shared";
import { addThreeMonths } from "../../../../../lib/mall-declarations";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Registra uma recarga efetivada: grava um evento no histórico e atualiza
// última/próxima recarga do cadastro.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR RECARGAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const rechargeId = safeText(id, 80);

  try {
    const body = (await request.json()) as JsonMap;
    const rechargeDate = safeText(body.rechargeDate, 10);
    if (!DATE_PATTERN.test(rechargeDate)) return jsonResponse({ error: "INFORME A DATA DA RECARGA." }, 400);
    const amountCents = Number(body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }
    const notes = safeText(body.notes, 1000);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM finance_phone_recharges WHERE id=?1")
      .bind(rechargeId)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "RECARGA NÃO ENCONTRADA." }, 404);

    const who = actor.displayName || "Administrador";
    const nextRechargeDate = addThreeMonths(rechargeDate);
    await database
      .prepare(
        `INSERT INTO finance_phone_recharge_events
          (id, recharge_id, recharge_date, amount_cents, notes, created_by, created_by_name, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP)`,
      )
      .bind(crypto.randomUUID(), rechargeId, rechargeDate, amountCents, notes, actor.id, who)
      .run();
    await database
      .prepare(
        `UPDATE finance_phone_recharges
         SET last_recharge_date=?1, last_amount_cents=?2, next_recharge_date=?3,
             updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
         WHERE id=?6`,
      )
      .bind(rechargeDate, amountCents, nextRechargeDate, actor.id, who, rechargeId)
      .run();
    return jsonResponse({ recorded: true, id: rechargeId, nextRechargeDate }, 201);
  } catch (error) {
    console.error("Não foi possível registrar a recarga.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A RECARGA." }, 500);
  }
}
