import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  MONTH_PATTERN,
  actorName,
  canManageTimeTracking,
  canViewTimeTracking,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Horas extras pagas em contracheque, por colaborador/competência — usado
// só para abater o banco de horas na aba "Saldo" (não vem da Folha).

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O CONTROLE DE HORAS." }, 403);
  }

  const url = new URL(request.url);
  const employeeId = safeText(url.searchParams.get("employeeId"), 80);
  if (!employeeId) return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT year_month AS yearMonth, paid_minutes AS paidMinutes, notes
         FROM hr_time_tracking_payouts WHERE employee_id=?1 ORDER BY year_month ASC`,
      )
      .bind(employeeId)
      .all<{ yearMonth: string; paidMinutes: number; notes: string }>();
    return jsonResponse({ payouts: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as horas pagas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS HORAS PAGAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR HORAS PAGAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    const yearMonth = safeText(body.yearMonth, 7);
    const paidMinutes = Number(body.paidMinutes);
    const notes = safeText(body.notes, 500);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);
    if (!MONTH_PATTERN.test(yearMonth)) {
      return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    }
    if (!Number.isFinite(paidMinutes) || paidMinutes < 0) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE DE HORAS PAGAS VÁLIDA." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare(`SELECT id FROM hr_time_tracking_payouts WHERE employee_id=?1 AND year_month=?2 LIMIT 1`)
      .bind(employeeId, yearMonth)
      .first<{ id: string }>();

    if (existing) {
      await database
        .prepare(
          `UPDATE hr_time_tracking_payouts
           SET paid_minutes=?1, notes=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
           WHERE id=?5`,
        )
        .bind(paidMinutes, notes, actor.id, actorName(actor), existing.id)
        .run();
      return jsonResponse({ updated: true, id: existing.id });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_time_tracking_payouts
          (id, employee_id, year_month, paid_minutes, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP)`,
      )
      .bind(id, employeeId, yearMonth, paidMinutes, notes, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar as horas pagas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR AS HORAS PAGAS." }, 500);
  }
}
