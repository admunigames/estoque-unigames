import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canViewSchedules, identity, isValidDate, isValidMonth, jsonResponse, safeText } from "../shared";

// RH > Escalas e Folgas — relatório calculado (coração do módulo). Nada
// aqui é persistido: a cada requisição, recalculamos a folga de domingo de
// cada colaborador (domingos do mês em que ele tem loja cadastrada e NÃO
// está na escala de domingo trabalhado) e juntamos com a folga de segunda a
// sábado lançada manualmente. Volume pequeno (dezenas de colaboradores,
// poucas dezenas de linhas por mês) — não se justifica persistir o
// resultado.

const WEEKDAY_LABELS_PT = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

type AssignmentRow = { employeeId: string; employeeName: string; companyId: string; companyName: string };
type SundayWorkRow = { employeeId: string; workDate: string; workTime: string };
type WeekdayOffRow = { employeeId: string; employeeName: string; offDate: string };
type DayNoteRow = { companyId: string; noteDate: string; notes: string };

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatDate(year: number, month: number, day: number) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function weekdayOf(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function addDays(dateStr: string, delta: number) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Domingo-Sábado: início da semana à qual a data pertence. */
function weekStartOf(dateStr: string) {
  return addDays(dateStr, -weekdayOf(dateStr));
}

function sundaysOfMonth(referenceMonth: string) {
  const year = Number(referenceMonth.slice(0, 4));
  const month = Number(referenceMonth.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const sundays: string[] = [];
  for (let day = 1; day <= lastDay; day++) {
    const dateStr = formatDate(year, month, day);
    if (weekdayOf(dateStr) === 0) sundays.push(dateStr);
  }
  return sundays;
}

/** Todos os dias do mês (não só domingos) — usado pra montar `stores` quando não há semana filtrada. */
function daysOfMonth(referenceMonth: string) {
  const year = Number(referenceMonth.slice(0, 4));
  const month = Number(referenceMonth.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day++) days.push(formatDate(year, month, day));
  return days;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewSchedules(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR ESCALAS E FOLGAS." }, 403);
  }

  const url = new URL(request.url);
  const referenceMonth = safeText(url.searchParams.get("referenceMonth"), 7);
  const week = safeText(url.searchParams.get("week"), 10);
  const companyIdFilter = safeText(url.searchParams.get("companyId"), 80);
  if (!isValidMonth(referenceMonth)) {
    return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);
  }
  if (week && !isValidDate(week)) {
    return jsonResponse({ error: "SEMANA INVÁLIDA." }, 400);
  }

  try {
    const database = await getD1();

    const assignmentsResult = await database
      .prepare(
        `SELECT employee_id AS employeeId, employee_name AS employeeName,
                company_id AS companyId, company_name AS companyName
         FROM hr_schedule_assignments WHERE reference_month=?1 ORDER BY employee_name ASC`,
      )
      .bind(referenceMonth)
      .all<AssignmentRow>();
    const assignments = assignmentsResult.results ?? [];

    const sundayWorkResult = await database
      .prepare(
        `SELECT employee_id AS employeeId, work_date AS workDate, work_time AS workTime
         FROM hr_schedule_sunday_work WHERE reference_month=?1`,
      )
      .bind(referenceMonth)
      .all<SundayWorkRow>();
    const sundayWorkByEmployee = new Map<string, Set<string>>();
    const sundayWorkTimeByKey = new Map<string, string>();
    for (const row of sundayWorkResult.results ?? []) {
      if (!sundayWorkByEmployee.has(row.employeeId)) sundayWorkByEmployee.set(row.employeeId, new Set());
      sundayWorkByEmployee.get(row.employeeId)!.add(row.workDate);
      sundayWorkTimeByKey.set(`${row.employeeId}|${row.workDate}`, row.workTime || "");
    }

    const weekdayOffResult = await database
      .prepare(
        `SELECT employee_id AS employeeId, employee_name AS employeeName, off_date AS offDate
         FROM hr_schedule_weekday_off WHERE reference_month=?1`,
      )
      .bind(referenceMonth)
      .all<WeekdayOffRow>();
    const weekdayOffByEmployee = new Map<string, string[]>();
    const weekdayOffSet = new Set<string>();
    for (const row of weekdayOffResult.results ?? []) {
      if (!weekdayOffByEmployee.has(row.employeeId)) weekdayOffByEmployee.set(row.employeeId, []);
      weekdayOffByEmployee.get(row.employeeId)!.push(row.offDate);
      weekdayOffSet.add(`${row.employeeId}|${row.offDate}`);
    }

    const dayNotesResult = await database
      .prepare(`SELECT company_id AS companyId, note_date AS noteDate, notes FROM hr_schedule_day_notes WHERE reference_month=?1`)
      .bind(referenceMonth)
      .all<DayNoteRow>();
    const dayNoteByKey = new Map<string, string>();
    for (const row of dayNotesResult.results ?? []) {
      dayNoteByKey.set(`${row.companyId}|${row.noteDate}`, row.notes || "");
    }

    const sundays = sundaysOfMonth(referenceMonth);

    type EmployeeOff = { employeeId: string; employeeName: string; companyId: string; companyName: string; offDates: string[] };
    const employeeOffs: EmployeeOff[] = assignments.map((assignment) => {
      const workedSundays = sundayWorkByEmployee.get(assignment.employeeId) ?? new Set<string>();
      const sundayOffs = sundays.filter((sunday) => !workedSundays.has(sunday));
      const weekdayOffs = weekdayOffByEmployee.get(assignment.employeeId) ?? [];
      const offDates = sundayOffs.concat(weekdayOffs).sort();
      return {
        employeeId: assignment.employeeId,
        employeeName: assignment.employeeName,
        companyId: assignment.companyId,
        companyName: assignment.companyName,
        offDates,
      };
    });

    const weekStartsSet = new Set<string>();
    for (const employee of employeeOffs) {
      for (const date of employee.offDates) weekStartsSet.add(weekStartOf(date));
    }
    const weeks = Array.from(weekStartsSet)
      .sort()
      .map((weekStart) => ({ weekStart, weekEnd: addDays(weekStart, 6) }));

    const weekEnd = week ? addDays(week, 6) : "";
    const filterByWeek = (date: string) => !week || (date >= week && date <= weekEnd);

    const dayMap = new Map<string, { employeeId: string; employeeName: string; companyId: string; companyName: string }[]>();
    const summary: {
      employeeId: string;
      employeeName: string;
      companyId: string;
      companyName: string;
      offs: { date: string; weekday: string }[];
      total: number;
    }[] = [];

    for (const employee of employeeOffs) {
      const filteredDates = employee.offDates.filter(filterByWeek);
      const offs = filteredDates.map((date) => ({ date, weekday: WEEKDAY_LABELS_PT[weekdayOf(date)] }));
      summary.push({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        companyId: employee.companyId,
        companyName: employee.companyName,
        offs,
        total: offs.length,
      });
      for (const date of filteredDates) {
        if (!dayMap.has(date)) dayMap.set(date, []);
        dayMap.get(date)!.push({
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          companyId: employee.companyId,
          companyName: employee.companyName,
        });
      }
    }

    const days = Array.from(dayMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, employees]) => ({
        date,
        weekday: WEEKDAY_LABELS_PT[weekdayOf(date)],
        employees: employees.slice().sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
      }));

    summary.sort((a, b) => a.employeeName.localeCompare(b.employeeName));

    // "stores" — tabela por loja/dia no estilo da planilha legada (item 5 do
    // pedido). Independente de days/summary (que cobrem todo mundo): filtra
    // só por companyId quando informado, e cobre a semana ou o mês inteiro.
    type StoreEmployee = { employeeId: string; employeeName: string };
    const storeEmployeesByCompany = new Map<string, { companyName: string; employees: StoreEmployee[] }>();
    for (const assignment of assignments) {
      if (companyIdFilter && assignment.companyId !== companyIdFilter) continue;
      if (!assignment.companyId) continue;
      if (!storeEmployeesByCompany.has(assignment.companyId)) {
        storeEmployeesByCompany.set(assignment.companyId, { companyName: assignment.companyName, employees: [] });
      }
      storeEmployeesByCompany.get(assignment.companyId)!.employees.push({
        employeeId: assignment.employeeId,
        employeeName: assignment.employeeName,
      });
    }

    const dayRange = week ? Array.from({ length: 7 }, (_, index) => addDays(week, index)) : daysOfMonth(referenceMonth);
    const periodStart = dayRange[0] ?? "";
    const periodEnd = dayRange[dayRange.length - 1] ?? "";

    const stores = Array.from(storeEmployeesByCompany.entries())
      .map(([companyId, store]) => {
        const employees = store.employees.slice().sort((a, b) => a.employeeName.localeCompare(b.employeeName));
        const storeDays = dayRange.map((date) => {
          const sunday = weekdayOf(date) === 0;
          let escalados: { employeeName: string; workTime?: string }[];
          let deFolga: { employeeName: string }[];
          if (sunday) {
            escalados = employees
              .filter((employee) => (sundayWorkByEmployee.get(employee.employeeId) ?? new Set()).has(date))
              .map((employee) => {
                const workTime = sundayWorkTimeByKey.get(`${employee.employeeId}|${date}`) || "";
                return workTime ? { employeeName: employee.employeeName, workTime } : { employeeName: employee.employeeName };
              });
            deFolga = employees
              .filter((employee) => !(sundayWorkByEmployee.get(employee.employeeId) ?? new Set()).has(date))
              .map((employee) => ({ employeeName: employee.employeeName }));
          } else {
            deFolga = employees
              .filter((employee) => weekdayOffSet.has(`${employee.employeeId}|${date}`))
              .map((employee) => ({ employeeName: employee.employeeName }));
            escalados = employees
              .filter((employee) => !weekdayOffSet.has(`${employee.employeeId}|${date}`))
              .map((employee) => ({ employeeName: employee.employeeName }));
          }
          return {
            date,
            weekday: WEEKDAY_LABELS_PT[weekdayOf(date)],
            escalados,
            deFolga,
            obs: dayNoteByKey.get(`${companyId}|${date}`) || "",
          };
        });
        return {
          companyId,
          companyName: store.companyName,
          periodStart,
          periodEnd,
          days: storeDays,
        };
      })
      .sort((a, b) => a.companyName.localeCompare(b.companyName));

    return jsonResponse({ weeks, days, summary, stores });
  } catch (error) {
    console.error("Não foi possível calcular a escala de folgas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CALCULAR A ESCALA DE FOLGAS." }, 500);
  }
}
