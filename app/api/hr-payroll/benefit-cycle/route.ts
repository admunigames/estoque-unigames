import { getD1 } from "../../../../db";
import { benefitCycle, cycleBenefitAmounts, type BenefitCycle } from "../../../lib/hr-benefit-cycle";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  BENEFIT_PAYMENT_METHODS,
  DATE_PATTERN,
  EMPLOYEE_COLUMNS,
  MONTH_PATTERN,
  actorName,
  canManagePayroll,
  identity,
  isOneOf,
  jsonResponse,
  loadScheduleDataForCycle,
  safeText,
  sameOrigin,
  workingDaysForEmployee,
  type Database,
  type EmployeeRow,
  type JsonMap,
} from "../shared";

// Fechamento do ciclo de benefícios (20 do mês → 19 do mês seguinte).
//
// GET  = prévia por colaborador ativo: escala, dias trabalhados no ciclo
//        (fórmula ou folgas reais do módulo Escalas), alimentação e
//        transporte (valor padrão por dia do cadastro × dias) e se o
//        lançamento do ciclo já foi gerado.
// POST = gera os lançamentos. Cada um vira um hr_benefits comum (origin =
//        'ciclo') com uma linha 'alimentacao' e/ou 'mobilidade' por dia
//        trabalhado — Folha, DRE e Fluxo de Caixa já leem sem mudança. O
//        índice único parcial hr_benefits_cycle_employee_month_idx impede
//        gerar duas vezes o mesmo funcionário/competência.

type GeneratedRow = {
  id: string;
  employeeId: string;
  amountCents: number;
  grossCents: number;
  paymentMethod: string;
  paymentDate: string;
};

type CycleRow = {
  employeeId: string;
  fullName: string;
  admissionDate: string;
  companyId: string;
  companyName: string;
  status: string;
  workSchedule: string;
  inEscalas: boolean;
  workingDays: number;
  source: string;
  offDays: number;
  holidays: number;
  foodPerDayCents: number;
  transportPerDayCents: number;
  foodCents: number;
  transportCents: number;
  totalCents: number;
  benefitNotes: string;
  generated: GeneratedRow | null;
};

async function buildCycleRows(
  database: Database,
  cycle: BenefitCycle,
  companyId: string,
): Promise<CycleRow[]> {
  const generatedResult = await database
    .prepare(
      `SELECT id, employee_id AS employeeId, amount_cents AS amountCents, gross_cents AS grossCents,
              payment_method AS paymentMethod, payment_date AS paymentDate
       FROM hr_benefits WHERE origin='ciclo' AND month=?1`,
    )
    .bind(cycle.month)
    .all<GeneratedRow>();
  const generatedByEmployee = new Map<string, GeneratedRow>();
  for (const row of generatedResult.results ?? []) generatedByEmployee.set(row.employeeId, row);

  // Ativos + quem já teve o ciclo gerado (mesmo que tenha saído depois).
  const params: string[] = [cycle.month];
  let companyCond = "";
  if (companyId) {
    params.push(companyId);
    companyCond = ` AND company_id=?${params.length}`;
  }
  const employeesResult = await database
    .prepare(
      `SELECT ${EMPLOYEE_COLUMNS} FROM hr_employees
       WHERE (status='active' OR id IN (SELECT employee_id FROM hr_benefits WHERE origin='ciclo' AND month=?1))
       ${companyCond}
       ORDER BY company_name ASC, full_name ASC`,
    )
    .bind(...params)
    .all<EmployeeRow>();
  const employees = employeesResult.results ?? [];

  const schedules = await loadScheduleDataForCycle(database, cycle);
  const holidays = new Map<string, string[]>();
  const rows: CycleRow[] = [];
  for (const employee of employees) {
    const days = await workingDaysForEmployee(database, employee, cycle.month, { holidays, schedules });
    const food = Number(employee.foodPerDayCents || 0);
    const transport = Number(employee.transportPerDayCents || 0);
    const amounts = cycleBenefitAmounts(days.workingDays, food, transport);
    const scheduleData = schedules.get(employee.id);
    rows.push({
      employeeId: employee.id,
      fullName: employee.fullName,
      admissionDate: employee.admissionDate,
      companyId: employee.companyId,
      companyName: employee.companyName,
      status: employee.status,
      workSchedule: days.schedule,
      // Tem loja lançada no Escalas em algum mês do ciclo — o módulo de
      // Escalas é 6x1; a tela avisa quando o cadastro diz 5x2.
      inEscalas: Boolean(scheduleData && scheduleData.assignedMonths.length),
      workingDays: days.workingDays,
      source: days.source,
      offDays: days.offDays,
      holidays: days.holidays,
      foodPerDayCents: food,
      transportPerDayCents: transport,
      foodCents: amounts.foodCents,
      transportCents: amounts.transportCents,
      totalCents: amounts.totalCents,
      benefitNotes: employee.benefitNotes || "",
      generated: generatedByEmployee.get(employee.id) ?? null,
    });
  }
  return rows;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR OS BENEFÍCIOS." }, 403);
  }
  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const cycle = MONTH_PATTERN.test(month) ? benefitCycle(month) : null;
  if (!cycle) return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);

  try {
    const database = await getD1();
    const rows = await buildCycleRows(database, cycle, companyId);
    return jsonResponse({
      month,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      rows,
      totalFoodCents: rows.reduce((sum, row) => sum + row.foodCents, 0),
      totalTransportCents: rows.reduce((sum, row) => sum + row.transportCents, 0),
      totalCents: rows.reduce((sum, row) => sum + row.totalCents, 0),
    });
  } catch (error) {
    console.error("Não foi possível montar o ciclo de benefícios.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O CICLO DE BENEFÍCIOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR BENEFÍCIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    const companyId = safeText(body.companyId, 80);
    const paymentMethod = safeText(body.paymentMethod, 20);
    const paymentDate = safeText(body.paymentDate, 10);
    const onlyIds = Array.isArray(body.employeeIds)
      ? new Set(body.employeeIds.map((value) => safeText(value, 80)).filter(Boolean))
      : null;
    const cycle = MONTH_PATTERN.test(month) ? benefitCycle(month) : null;
    if (!cycle) return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    if (!isOneOf(BENEFIT_PAYMENT_METHODS, paymentMethod)) {
      return jsonResponse({ error: "SELECIONE UMA FORMA DE PAGAMENTO VÁLIDA." }, 400);
    }
    if (paymentDate && !DATE_PATTERN.test(paymentDate)) {
      return jsonResponse({ error: "INFORME UMA DATA DE PAGAMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
    }

    const database = await getD1();
    const rows = await buildCycleRows(database, cycle, companyId);
    const toGenerate = rows.filter(
      (row) =>
        row.status === "active" &&
        !row.generated &&
        row.totalCents > 0 &&
        (!onlyIds || onlyIds.has(row.employeeId)),
    );
    const skipped = rows.filter(
      (row) => row.status === "active" && !row.generated && row.totalCents <= 0 && (!onlyIds || onlyIds.has(row.employeeId)),
    ).length;
    if (!toGenerate.length) {
      return jsonResponse({ created: 0, skipped });
    }

    const note = `Gerado pelo ciclo ${cycle.start.split("-").reverse().join("/")} a ${cycle.end.split("-").reverse().join("/")}`;
    const statements = [];
    for (const row of toGenerate) {
      const benefitId = crypto.randomUUID();
      const items = [
        { type: "alimentacao", perDay: row.foodPerDayCents, amount: row.foodCents },
        { type: "mobilidade", perDay: row.transportPerDayCents, amount: row.transportCents },
      ].filter((item) => item.amount > 0);
      const headerType = items.length === 1 ? items[0].type : "multiplo";
      const notes = row.benefitNotes ? `${note} · ${row.benefitNotes}`.slice(0, 500) : note;
      statements.push(
        database
          .prepare(
            `INSERT INTO hr_benefits
              (id, employee_id, employee_name, company_id, company_name, month, type, payment_method,
               amount_cents, gross_cents, discount_cents, payment_date, notes, origin, created_by,
               created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 0, ?10, ?11, 'ciclo', ?12, ?13,
                     CURRENT_TIMESTAMP, ?12, ?13, CURRENT_TIMESTAMP)`,
          )
          .bind(
            benefitId,
            row.employeeId,
            row.fullName,
            row.companyId,
            row.companyName,
            cycle.month,
            headerType,
            paymentMethod,
            row.totalCents,
            paymentDate,
            notes,
            actor.id,
            actorName(actor),
          ),
      );
      for (const item of items) {
        statements.push(
          database
            .prepare(
              `INSERT INTO hr_benefit_items
                (id, benefit_id, type, amount_mode, per_day_rate_cents, working_days,
                 amount_cents, discount_cents, created_by, created_at)
               VALUES (?1, ?2, ?3, 'per_day', ?4, ?5, ?6, 0, ?7, CURRENT_TIMESTAMP)`,
            )
            .bind(crypto.randomUUID(), benefitId, item.type, item.perDay, row.workingDays, item.amount, actor.id),
        );
      }
    }
    // Tudo ou nada: se outra geração simultânea já criou algum lançamento,
    // o índice único derruba o batch inteiro e nada fica pela metade.
    await database.batch(statements);
    return jsonResponse({ created: toGenerate.length, skipped }, 201);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.includes("hr_benefits_cycle_employee_month_idx") || message.includes("duplicate key")) {
      return jsonResponse(
        { error: "O CICLO DE ALGUM FUNCIONÁRIO ACABOU DE SER GERADO EM OUTRA TELA. RECARREGUE E TENTE DE NOVO." },
        409,
      );
    }
    console.error("Não foi possível gerar os benefícios do ciclo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GERAR OS BENEFÍCIOS DO CICLO." }, 500);
  }
}
