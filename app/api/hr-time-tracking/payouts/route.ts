import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { bankPaidMinutes, OVERTIME_KINDS, suggestedHourlyRateCents, type OvertimeKind } from "../../../lib/hr-accounting-report";
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

// Horas extras pagas em contracheque, por colaborador/competência — abate o
// banco de horas na aba "Saldo". Desde 22/10/2026 é também a FONTE ÚNICA das
// HORAS EXTRAS A PAGAR, em três tipos (HE 50%, HE 100% e ADICIONAL NOTURNO):
// minutos + valor da hora (salário ÷ 220 × fator, editável). Com os tipos
// informados, paid_minutes = HE 50% + HE 100% (o adicional noturno não é hora
// extra e não abate o banco). Sem tipos, vale o total digitado (como antes).

const PAYOUT_COLUMNS = `year_month AS yearMonth, paid_minutes AS paidMinutes, notes,
  he50_minutes AS he50Minutes, he100_minutes AS he100Minutes, night_minutes AS nightMinutes,
  he50_rate_cents AS he50RateCents, he100_rate_cents AS he100RateCents, night_rate_cents AS nightRateCents`;

const RATE_COLUMN: Record<OvertimeKind, string> = { he50: "he50RateCents", he100: "he100RateCents", night: "nightRateCents" };
const MINUTES_COLUMN: Record<OvertimeKind, string> = { he50: "he50Minutes", he100: "he100Minutes", night: "nightMinutes" };

/** Valor da hora sugerido de cada tipo — só para quem vê salário (RH Financeiro). */
async function suggestedRates(database: Awaited<ReturnType<typeof getD1>>, employeeId: string) {
  const row = await database
    .prepare("SELECT salary_cents AS salaryCents FROM hr_employees WHERE id=?1")
    .bind(employeeId)
    .first<{ salaryCents: number }>();
  const salary = Number(row?.salaryCents ?? 0);
  return Object.fromEntries(OVERTIME_KINDS.map(({ key }) => [key, suggestedHourlyRateCents(salary, key)])) as Record<OvertimeKind, number>;
}

function canSeeSalary(actor: { role: string; permissions: string[] }) {
  return actor.role === "admin" || actor.permissions.includes("payroll:manage");
}

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
      .prepare(`SELECT ${PAYOUT_COLUMNS} FROM hr_time_tracking_payouts WHERE employee_id=?1 ORDER BY year_month ASC`)
      .bind(employeeId)
      .all();
    return jsonResponse({
      payouts: result.results ?? [],
      overtimeKinds: OVERTIME_KINDS,
      suggestedRateCents: canSeeSalary(actor) ? await suggestedRates(database, employeeId) : null,
    });
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
    let paidMinutes = Number(body.paidMinutes);
    const notes = safeText(body.notes, 500);
    const typed = OVERTIME_KINDS.some(({ key }) => body[MINUTES_COLUMN[key]] !== undefined);
    const minutes = {} as Record<OvertimeKind, number>;
    const rates = {} as Record<OvertimeKind, number>;
    for (const { key } of OVERTIME_KINDS) {
      minutes[key] = Number(body[MINUTES_COLUMN[key]] ?? 0);
      rates[key] = Number(body[RATE_COLUMN[key]] ?? 0);
      if (!Number.isInteger(minutes[key]) || minutes[key] < 0 || minutes[key] > 744 * 60) {
        return jsonResponse({ error: "INFORME UMA QUANTIDADE DE HORAS VÁLIDA EM CADA TIPO." }, 400);
      }
      if (!Number.isInteger(rates[key]) || rates[key] < 0 || rates[key] > 10_000_000) {
        return jsonResponse({ error: "INFORME UM VALOR DA HORA VÁLIDO EM CADA TIPO." }, 400);
      }
    }
    if (typed) paidMinutes = bankPaidMinutes({ he50: { minutes: minutes.he50, rateCents: 0 }, he100: { minutes: minutes.he100, rateCents: 0 } });

    if (!employeeId) return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);
    if (!MONTH_PATTERN.test(yearMonth)) {
      return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    }
    if (!Number.isFinite(paidMinutes) || paidMinutes < 0) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE DE HORAS PAGAS VÁLIDA." }, 400);
    }

    const database = await getD1();
    // Valor da hora em branco (0) com horas lançadas → o sugerido do salário.
    if (OVERTIME_KINDS.some(({ key }) => minutes[key] > 0 && !rates[key])) {
      const suggested = await suggestedRates(database, employeeId);
      for (const { key } of OVERTIME_KINDS) if (minutes[key] > 0 && !rates[key]) rates[key] = suggested[key];
    }
    for (const { key } of OVERTIME_KINDS) if (!minutes[key]) rates[key] = 0;
    const existing = await database
      .prepare(`SELECT id FROM hr_time_tracking_payouts WHERE employee_id=?1 AND year_month=?2 LIMIT 1`)
      .bind(employeeId, yearMonth)
      .first<{ id: string }>();
    const typeValues = [minutes.he50, minutes.he100, minutes.night, rates.he50, rates.he100, rates.night];

    if (existing) {
      await database
        .prepare(
          `UPDATE hr_time_tracking_payouts
           SET paid_minutes=?1, notes=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP,
               he50_minutes=?6, he100_minutes=?7, night_minutes=?8, he50_rate_cents=?9, he100_rate_cents=?10, night_rate_cents=?11
           WHERE id=?5`,
        )
        .bind(paidMinutes, notes, actor.id, actorName(actor), existing.id, ...typeValues)
        .run();
      return jsonResponse({ updated: true, id: existing.id, paidMinutes });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_time_tracking_payouts
          (id, employee_id, year_month, paid_minutes, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at,
           he50_minutes, he100_minutes, night_minutes, he50_rate_cents, he100_rate_cents, night_rate_cents)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(id, employeeId, yearMonth, paidMinutes, notes, actor.id, actorName(actor), ...typeValues)
      .run();
    return jsonResponse({ created: true, id, paidMinutes }, 201);
  } catch (error) {
    console.error("Não foi possível salvar as horas pagas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR AS HORAS PAGAS." }, 500);
  }
}
