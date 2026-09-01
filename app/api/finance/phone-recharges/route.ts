import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import { addThreeMonths } from "../../../lib/mall-declarations";

// Recargas de Celulares (Financeiro — Fase 8). Próxima recarga é sempre
// última recarga + 3 meses (calculada aqui). O lembrete é enviado por push
// ao Financeiro pelo cron (dispatchDuePhoneRechargeNotifications no Worker).

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const SELECT_COLUMNS = `id, phone_number AS phoneNumber, carrier, company_id AS companyId,
  company_name AS companyName, responsible_name AS responsibleName,
  last_amount_cents AS lastAmountCents, last_recharge_date AS lastRechargeDate,
  next_recharge_date AS nextRechargeDate, notes, active,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const params = new URL(request.url).searchParams;
  const rechargeId = safeText(params.get("rechargeId"), 80);

  try {
    const database = await getD1();
    if (rechargeId) {
      const events = await database
        .prepare(
          `SELECT id, recharge_date AS rechargeDate, amount_cents AS amountCents, notes,
                  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
           FROM finance_phone_recharge_events WHERE recharge_id=?1
           ORDER BY recharge_date DESC, created_at DESC LIMIT 500`,
        )
        .bind(rechargeId)
        .all();
      return jsonResponse({ events: events.results ?? [] });
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    const companyId = safeText(params.get("companyId"), 80);
    if (companyId) {
      values.push(companyId);
      conditions.push(`company_id = ?${values.length}`);
    }
    if (params.get("active") === "1") conditions.push("active = 1");
    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await database
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM finance_phone_recharges
         ${whereSql} ORDER BY next_recharge_date ASC, phone_number ASC LIMIT 1000`,
      )
      .bind(...values)
      .all();
    return jsonResponse({ rows: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as recargas de celular.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS RECARGAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR RECARGAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const phoneNumber = safeText(body.phoneNumber, 40);
    if (phoneNumber.length < 8) return jsonResponse({ error: "INFORME O NÚMERO DO CELULAR." }, 400);
    const carrier = safeText(body.carrier, 60);
    if (!carrier) return jsonResponse({ error: "INFORME A OPERADORA." }, 400);
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A UNIDADE." }, 400);
    const responsibleName = safeText(body.responsibleName, 160);
    const notes = safeText(body.notes, 2000);
    const active = body.active === false ? 0 : 1;
    const lastRechargeDate = safeText(body.lastRechargeDate, 10);
    if (!DATE_PATTERN.test(lastRechargeDate)) {
      return jsonResponse({ error: "INFORME A DATA DA ÚLTIMA RECARGA." }, 400);
    }
    const lastAmountCents = Number(body.lastAmountCents);
    if (!Number.isInteger(lastAmountCents) || lastAmountCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }
    const nextRechargeDate = addThreeMonths(lastRechargeDate);

    const database = await getD1();
    const who = actor.displayName || "Administrador";

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM finance_phone_recharges WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "RECARGA NÃO ENCONTRADA." }, 404);
      await database
        .prepare(
          `UPDATE finance_phone_recharges
           SET phone_number=?1, carrier=?2, company_id=?3, company_name=?4, responsible_name=?5,
               last_amount_cents=?6, last_recharge_date=?7, next_recharge_date=?8, notes=?9, active=?10,
               updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP
           WHERE id=?13`,
        )
        .bind(
          phoneNumber, carrier, companyId, companyName, responsibleName, lastAmountCents,
          lastRechargeDate, nextRechargeDate, notes, active, actor.id, who, editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId, nextRechargeDate });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_phone_recharges
          (id, phone_number, carrier, company_id, company_name, responsible_name,
           last_amount_cents, last_recharge_date, next_recharge_date, notes, active,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,CURRENT_TIMESTAMP,?12,?13,CURRENT_TIMESTAMP)`,
      )
      .bind(
        id, phoneNumber, carrier, companyId, companyName, responsibleName, lastAmountCents,
        lastRechargeDate, nextRechargeDate, notes, active, actor.id, who,
      )
      .run();
    return jsonResponse({ created: true, id, nextRechargeDate }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a recarga de celular.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A RECARGA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR RECARGAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "RECARGA INVÁLIDA." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM finance_phone_recharge_events WHERE recharge_id=?1").bind(id).run();
    await database.prepare("DELETE FROM finance_phone_recharges WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a recarga de celular.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A RECARGA." }, 500);
  }
}
