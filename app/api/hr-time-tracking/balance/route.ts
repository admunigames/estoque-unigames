import { getD1 } from "../../../../db";
import { aggregateMonthlyBalance } from "../../../lib/hr-time-tracking";
import { unauthorizedResponse } from "../../../lib/notion";
import { canViewTimeTracking, identity, jsonResponse, safeText } from "../shared";

// Aba "Saldo" — agrega os lançamentos diários por mês e acumula o banco de
// horas mês a mês, descontando o que já foi pago em cada competência (ver
// aggregateMonthlyBalance em app/lib/hr-time-tracking.ts).

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
    const [entriesResult, payoutsResult] = await Promise.all([
      database
        .prepare(
          `SELECT substr(entry_date,1,7) AS yearMonth, worked_minutes AS workedMinutes,
                  target_minutes AS targetMinutes, balance_minutes AS balanceMinutes
           FROM hr_time_tracking_entries WHERE employee_id=?1`,
        )
        .bind(employeeId)
        .all<{ yearMonth: string; workedMinutes: number; targetMinutes: number; balanceMinutes: number }>(),
      database
        .prepare(`SELECT year_month AS yearMonth, paid_minutes AS paidMinutes FROM hr_time_tracking_payouts WHERE employee_id=?1`)
        .bind(employeeId)
        .all<{ yearMonth: string; paidMinutes: number }>(),
    ]);

    const paidMinutesByMonth: Record<string, number> = {};
    for (const row of payoutsResult.results ?? []) {
      paidMinutesByMonth[row.yearMonth] = row.paidMinutes;
    }
    const months = aggregateMonthlyBalance(entriesResult.results ?? [], paidMinutesByMonth);
    return jsonResponse({ months });
  } catch (error) {
    console.error("Não foi possível calcular o saldo de horas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CALCULAR O SALDO DE HORAS." }, 500);
  }
}
