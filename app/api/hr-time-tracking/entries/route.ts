import { getD1 } from "../../../../db";
import { computeDailyBalance, formatPunches, parsePunches, validatePunches } from "../../../lib/hr-time-tracking";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  MONTH_PATTERN,
  actorName,
  canManageTimeTracking,
  canViewTimeTracking,
  identity,
  jsonResponse,
  loadDailyTargetMinutes,
  safeText,
  sameOrigin,
  uuidIsValid,
  type JsonMap,
} from "../shared";

type EntryRow = {
  id: string;
  employeeId: string;
  entryDate: string;
  punches: string;
  workedMinutes: number;
  targetMinutes: number;
  balanceMinutes: number;
  notes: string;
};

const COLUMNS = `id, employee_id AS employeeId, entry_date AS entryDate, punches,
  worked_minutes AS workedMinutes, target_minutes AS targetMinutes, balance_minutes AS balanceMinutes, notes`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O CONTROLE DE HORAS." }, 403);
  }

  const url = new URL(request.url);
  const employeeId = safeText(url.searchParams.get("employeeId"), 80);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!employeeId) return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);
  if (month && !MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }

  try {
    const database = await getD1();
    const result = month
      ? await database
          .prepare(
            `SELECT ${COLUMNS} FROM hr_time_tracking_entries
             WHERE employee_id=?1 AND entry_date LIKE ?2
             ORDER BY entry_date DESC`,
          )
          .bind(employeeId, `${month}-%`)
          .all<EntryRow>()
      : await database
          .prepare(`SELECT ${COLUMNS} FROM hr_time_tracking_entries WHERE employee_id=?1 ORDER BY entry_date DESC`)
          .bind(employeeId)
          .all<EntryRow>();
    return jsonResponse({ entries: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os lançamentos de ponto.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS LANÇAMENTOS DE PONTO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O PONTO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const entryDate = safeText(body.entryDate, 10);
    const punches = parsePunches(safeText(body.punches, 500));
    const notes = safeText(body.notes, 500);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);
    if (!DATE_PATTERN.test(entryDate)) {
      return jsonResponse({ error: "INFORME UMA DATA VÁLIDA (AAAA-MM-DD)." }, 400);
    }
    const validation = validatePunches(punches);
    if (!validation.ok) return jsonResponse({ error: validation.error }, 400);

    const targetMinutes = await loadDailyTargetMinutes(employeeId);
    const { workedMinutes, balanceMinutes } = computeDailyBalance(validation.minutesList, targetMinutes);
    const punchesText = formatPunches(punches);

    const database = await getD1();

    if (editId) {
      const existing = await database
        .prepare("SELECT id, employee_id AS employeeId FROM hr_time_tracking_entries WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string; employeeId: string }>();
      if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
      if (existing.employeeId !== employeeId) {
        return jsonResponse({ error: "NÃO É POSSÍVEL MUDAR O COLABORADOR DE UM REGISTRO EXISTENTE." }, 400);
      }
      const conflict = await database
        .prepare(
          `SELECT id FROM hr_time_tracking_entries WHERE employee_id=?1 AND entry_date=?2 AND id<>?3 LIMIT 1`,
        )
        .bind(employeeId, entryDate, editId)
        .first<{ id: string }>();
      if (conflict) return jsonResponse({ error: "JÁ EXISTE UM LANÇAMENTO PARA ESTE COLABORADOR NESTA DATA." }, 400);

      await database
        .prepare(
          `UPDATE hr_time_tracking_entries
           SET entry_date=?1, punches=?2, worked_minutes=?3, target_minutes=?4, balance_minutes=?5, notes=?6,
               updated_by=?7, updated_by_name=?8, updated_at=CURRENT_TIMESTAMP
           WHERE id=?9`,
        )
        .bind(entryDate, punchesText, workedMinutes, targetMinutes, balanceMinutes, notes, actor.id, actorName(actor), editId)
        .run();
      return jsonResponse({ updated: true, id: editId, workedMinutes, targetMinutes, balanceMinutes });
    }

    const conflict = await database
      .prepare(`SELECT id FROM hr_time_tracking_entries WHERE employee_id=?1 AND entry_date=?2 LIMIT 1`)
      .bind(employeeId, entryDate)
      .first<{ id: string }>();
    if (conflict) return jsonResponse({ error: "JÁ EXISTE UM LANÇAMENTO PARA ESTE COLABORADOR NESTA DATA." }, 400);

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_time_tracking_entries
          (id, employee_id, entry_date, punches, worked_minutes, target_minutes, balance_minutes, notes,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)`,
      )
      .bind(id, employeeId, entryDate, punchesText, workedMinutes, targetMinutes, balanceMinutes, notes, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id, workedMinutes, targetMinutes, balanceMinutes }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o lançamento de ponto.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LANÇAMENTO DE PONTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR O LANÇAMENTO DE PONTO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "REGISTRO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_time_tracking_entries WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_time_tracking_entries WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento de ponto.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO DE PONTO." }, 500);
  }
}

// Grade do mês (out/2026): grava todos os dias de uma vez, como numa
// planilha. Dia com marcações = cria/atualiza; dia vazio = apaga o
// lançamento daquele dia. Valida tudo antes de gravar (nada pela metade).
export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O PONTO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const body = (await request.json()) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    const month = safeText(body.month, 7);
    if (!employeeId) return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return jsonResponse({ error: "INFORME O MÊS." }, 400);
    const days = (Array.isArray(body.days) ? body.days : [])
      .map((day) => (day && typeof day === "object" ? (day as JsonMap) : {}))
      .map((day) => ({
        entryDate: safeText(day.entryDate, 10),
        punches: parsePunches(safeText(day.punches, 500)),
        notes: safeText(day.notes, 500),
      }))
      .filter((day) => DATE_PATTERN.test(day.entryDate) && day.entryDate.startsWith(month));
    const targetMinutes = await loadDailyTargetMinutes(employeeId);
    const filled = [];
    for (const day of days.filter((item) => item.punches.length)) {
      const validation = validatePunches(day.punches);
      if (!validation.ok) {
        return jsonResponse({ error: `${day.entryDate.slice(8, 10)}/${day.entryDate.slice(5, 7)}: ${validation.error}` }, 400);
      }
      filled.push({ ...day, ...computeDailyBalance(validation.minutesList, targetMinutes) });
    }
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, entry_date AS entryDate FROM hr_time_tracking_entries WHERE employee_id=?1 AND substr(entry_date, 1, 7)=?2")
      .bind(employeeId, month)
      .all<{ id: string; entryDate: string }>();
    const byDate = new Map((existing.results ?? []).map((row) => [row.entryDate, row.id]));
    const statements = [];
    for (const day of filled) {
      const id = byDate.get(day.entryDate);
      statements.push(id
        ? database
            .prepare(
              `UPDATE hr_time_tracking_entries SET punches=?1, worked_minutes=?2, target_minutes=?3, balance_minutes=?4,
                 notes=?5, updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP WHERE id=?8`,
            )
            .bind(formatPunches(day.punches), day.workedMinutes, day.targetMinutes, day.balanceMinutes, day.notes,
              actor.id, actorName(actor), id)
        : database
            .prepare(
              `INSERT INTO hr_time_tracking_entries
                (id, employee_id, entry_date, punches, worked_minutes, target_minutes, balance_minutes, notes,
                 created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)`,
            )
            .bind(crypto.randomUUID(), employeeId, day.entryDate, formatPunches(day.punches), day.workedMinutes,
              day.targetMinutes, day.balanceMinutes, day.notes, actor.id, actorName(actor)));
    }
    const filledDates = new Set(filled.map((day) => day.entryDate));
    for (const day of days) {
      const id = byDate.get(day.entryDate);
      if (id && !filledDates.has(day.entryDate)) {
        statements.push(database.prepare("DELETE FROM hr_time_tracking_entries WHERE id=?1").bind(id));
      }
    }
    if (statements.length) await database.batch(statements);
    return jsonResponse({ saved: filled.length, targetMinutes });
  } catch (error) {
    console.error("Não foi possível salvar o mês do ponto.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O MÊS." }, 500);
  }
}
