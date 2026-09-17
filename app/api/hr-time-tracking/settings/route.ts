import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageTimeTracking,
  canViewTimeTracking,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
  type TimeTrackingSettingsRow,
} from "../shared";

// Jornada diária contratada por colaborador — referência para calcular
// hora extra. Confirmado com o usuário: varia por colaborador/cargo, então
// cada um tem seu próprio valor (padrão 480min/8h quando não configurado).

const COLUMNS = `id, employee_id AS employeeId, daily_target_minutes AS dailyTargetMinutes, notes`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O CONTROLE DE HORAS." }, 403);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(`SELECT ${COLUMNS} FROM hr_time_tracking_settings ORDER BY employee_id ASC`)
      .all<TimeTrackingSettingsRow>();
    return jsonResponse({ settings: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as jornadas contratadas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS JORNADAS CONTRATADAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONFIGURAR A JORNADA CONTRATADA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    const dailyTargetMinutes = Number(body.dailyTargetMinutes);
    const notes = safeText(body.notes, 500);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);
    if (!Number.isFinite(dailyTargetMinutes) || dailyTargetMinutes < 0 || dailyTargetMinutes > 1440) {
      return jsonResponse({ error: "INFORME UMA JORNADA DIÁRIA VÁLIDA (EM MINUTOS)." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare(`SELECT id FROM hr_time_tracking_settings WHERE employee_id=?1 LIMIT 1`)
      .bind(employeeId)
      .first<{ id: string }>();

    if (existing) {
      await database
        .prepare(
          `UPDATE hr_time_tracking_settings
           SET daily_target_minutes=?1, notes=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
           WHERE employee_id=?5`,
        )
        .bind(dailyTargetMinutes, notes, actor.id, actorName(actor), employeeId)
        .run();
      return jsonResponse({ updated: true, id: existing.id });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_time_tracking_settings
          (id, employee_id, daily_target_minutes, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, ?5, ?6, CURRENT_TIMESTAMP)`,
      )
      .bind(id, employeeId, dailyTargetMinutes, notes, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a jornada contratada.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A JORNADA CONTRATADA." }, 500);
  }
}
