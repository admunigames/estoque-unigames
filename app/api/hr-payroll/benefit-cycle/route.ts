import { getD1 } from "../../../../db";
import {
  benefitCycle,
  cycleBenefitAmounts,
  employeeBenefitRule,
  parseBenefitRules,
  type BenefitCycle,
  type BenefitRules,
} from "../../../lib/hr-benefit-cycle";
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
  loadBenefitRules,
  safeText,
  sameOrigin,
  workingDaysForEmployee,
  type Database,
  type EmployeeRow,
  type JsonMap,
} from "../shared";

// Fechamento do ciclo de benefícios (20 do mês → 19 do mês seguinte).
//
// GET  = prévia por colaborador ativo: escala, dias exatos do ciclo
//        (5x2 seg–sex, 6x1 seg–sáb), alimentação cheia e transporte por dia
//        da aba REGRAS, e se o lançamento do ciclo já foi gerado.
// POST = gera os lançamentos já revisados (adjustments: dias de passagem,
//        ajuste ± da alimentação e motivo por funcionário). Cada um vira um
//        hr_benefits comum (origin = 'ciclo') com uma linha 'alimentacao'
//        e/ou 'mobilidade' — Folha, DRE e Fluxo de Caixa já leem sem mudança.
//        Quem JÁ foi gerado e vem com ajuste tem o lançamento atualizado
//        (valores, linhas e observação), mantendo forma/data de pagamento.
// PUT  = salva as regras (alimentação cheia e transporte/dia por escala). O
//        índice único parcial hr_benefits_cycle_employee_month_idx impede
//        gerar duas vezes o mesmo funcionário/competência.
// PATCH = RASCUNHO da revisão (23/11/2026, pedido do usuário: "sair da página e
//        voltar com a passagem lá"): dias de passagem, ajuste da alimentação e
//        motivo de quem AINDA NÃO foi gerado, e a forma/data do pagamento. Uma
//        linha de hr_settings por funcionário (sem migration, sem corrida entre
//        dois usuários). Quem já foi gerado é salvo direto no lançamento (POST).
//        Gerar apaga o rascunho de quem foi gerado.

const DRAFT_PREFIX = "benefit_cycle_draft:";
const draftKey = (month: string, employeeId: string) => `${DRAFT_PREFIX}${month}:${employeeId}`;
const PAYMENT_DRAFT = "_pagamento";

type CycleDraft = { transportDays: number | null; foodAdjustCents: number; transportAdjustCents: number; reason: string };

/** Ajuste em centavos (± R$ 100.000,00) ou 0. */
const adjustValue = (value: unknown) => {
  const number = Number(value);
  return Number.isInteger(number) && Math.abs(number) <= 10_000_000 ? number : 0;
};
const brl = (cents: number) => `${cents > 0 ? "+" : "−"}R$ ${(Math.abs(cents) / 100).toFixed(2).replace(".", ",")}`;

/** Rascunho válido ou null (vazio = sem ajuste nenhum = apaga). */
function parseDraft(value: unknown): CycleDraft | null {
  if (!value || typeof value !== "object") return null;
  const input = value as JsonMap;
  const days = input.transportDays === null || input.transportDays === undefined || input.transportDays === "" ? null : Number(input.transportDays);
  const transportDays = days !== null && Number.isInteger(days) && days >= 0 && days <= 31 ? days : null;
  const foodAdjustCents = adjustValue(input.foodAdjustCents);
  const transportAdjustCents = adjustValue(input.transportAdjustCents);
  const reason = safeText(input.reason, 200).toUpperCase();
  if (transportDays === null && !foodAdjustCents && !transportAdjustCents && !reason) return null;
  return { transportDays, foodAdjustCents, transportAdjustCents, reason };
}

async function loadDrafts(database: Database, month: string) {
  const result = await database
    .prepare("SELECT key, value_json AS value FROM hr_settings WHERE key LIKE ?1")
    .bind(`${DRAFT_PREFIX}${month}:%`)
    .all<{ key: string; value: string }>();
  const drafts: Record<string, CycleDraft> = {};
  let payment: { paymentMethod: string; paymentDate: string } | null = null;
  for (const row of result.results ?? []) {
    const employeeId = row.key.slice(`${DRAFT_PREFIX}${month}:`.length);
    let value: unknown = null;
    try { value = JSON.parse(row.value); } catch { value = null; }
    if (employeeId === PAYMENT_DRAFT) {
      const input = (value ?? {}) as JsonMap;
      payment = { paymentMethod: safeText(input.paymentMethod, 20), paymentDate: safeText(input.paymentDate, 10) };
      continue;
    }
    const draft = parseDraft(value);
    if (draft) drafts[employeeId] = draft;
  }
  return { drafts, payment };
}

type GeneratedRow = {
  id: string;
  employeeId: string;
  amountCents: number;
  grossCents: number;
  paymentMethod: string;
  paymentDate: string;
  notes: string;
  /** Dias de passagem e alimentação gravados (base da revisão na tela). */
  transportDays: number | null;
  foodCents: number;
  /** Passagem gravada e o valor do dia usado — a diferença é o AJUSTE DO TRANSPORTE. */
  transportCents: number;
  transportRateCents: number;
};

type CycleRow = {
  employeeId: string;
  fullName: string;
  admissionDate: string;
  companyId: string;
  companyName: string;
  status: string;
  workSchedule: string;
  workingDays: number;
  ruleFoodCents: number;
  transportPerDayCents: number;
  /** VALOR TOTAL de transporte do cadastro (0 = regra × dias). */
  transportTotalCents: number;
  countedDays: number;
  benefitPaymentMethod: string;
  /** RECEBE TRANSPORTE? do cadastro — NÃO = passagem sempre 0. */
  receivesTransport: boolean;
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
  rules: BenefitRules,
): Promise<CycleRow[]> {
  const generatedResult = await database
    .prepare(
      `SELECT id, employee_id AS employeeId, amount_cents AS amountCents, gross_cents AS grossCents,
              payment_method AS paymentMethod, payment_date AS paymentDate, notes,
              (SELECT MAX(working_days) FROM hr_benefit_items i WHERE i.benefit_id=b.id AND i.type='mobilidade') AS transportDays,
              COALESCE((SELECT SUM(amount_cents) FROM hr_benefit_items i WHERE i.benefit_id=b.id AND i.type='alimentacao'), 0) AS foodCents,
              COALESCE((SELECT SUM(amount_cents) FROM hr_benefit_items i WHERE i.benefit_id=b.id AND i.type='mobilidade'), 0) AS transportCents,
              COALESCE((SELECT MAX(per_day_rate_cents) FROM hr_benefit_items i WHERE i.benefit_id=b.id AND i.type='mobilidade'), 0) AS transportRateCents
       FROM hr_benefits b WHERE origin='ciclo' AND month=?1`,
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

  return employees.map((employee) => {
    const days = workingDaysForEmployee(employee, cycle.month);
    const rule = employeeBenefitRule(rules[days.schedule], employee, days.workingDays);
    const amounts = cycleBenefitAmounts(rule, days.workingDays);
    return {
      employeeId: employee.id,
      fullName: employee.fullName,
      admissionDate: employee.admissionDate,
      companyId: employee.companyId,
      companyName: employee.companyName,
      status: employee.status,
      workSchedule: days.schedule,
      workingDays: days.workingDays,
      ruleFoodCents: rule.foodCents,
      transportPerDayCents: rule.transportPerDayCents,
      transportTotalCents: rule.transportTotalCents,
      countedDays: rule.countedDays,
      benefitPaymentMethod: employee.benefitPaymentMethod || "",
      receivesTransport: rule.receivesTransport,
      foodCents: amounts.foodCents,
      transportCents: amounts.transportCents,
      totalCents: amounts.totalCents,
      benefitNotes: employee.benefitNotes || "",
      generated: generatedByEmployee.get(employee.id) ?? null,
    };
  });
}

// Revisão antes do pagamento: dias de passagem, ajuste ± da alimentação e
// motivo (FALTA, ATESTADO, FERIADO…) vindos da tabela do ciclo.
function reviewed(row: CycleRow, adjustments: unknown): CycleRow & { reviewNote: string } {
  const input = (adjustments && typeof adjustments === "object" ? (adjustments as JsonMap)[row.employeeId] : null) as JsonMap | null;
  if (!input || typeof input !== "object") return { ...row, reviewNote: "" };
  const days = Number(input.transportDays);
  const transportDays = Number.isInteger(days) && days >= 0 && days <= 31 ? days : row.workingDays;
  const foodAdjustCents = adjustValue(input.foodAdjustCents);
  // Quem não recebe transporte não tem passagem nem ajuste de passagem.
  const transportAdjustCents = row.receivesTransport ? adjustValue(input.transportAdjustCents) : 0;
  const reason = safeText(input.reason, 200).toUpperCase();
  const amounts = cycleBenefitAmounts(
    {
      foodCents: row.ruleFoodCents, transportPerDayCents: row.transportPerDayCents, transportTotalCents: row.transportTotalCents,
      countedDays: row.countedDays, receivesTransport: row.receivesTransport,
    },
    transportDays,
    foodAdjustCents,
    transportAdjustCents,
  );
  const changes = [
    row.receivesTransport && transportDays !== row.workingDays ? `PASSAGEM ${transportDays} DE ${row.workingDays} DIAS` : "",
    transportAdjustCents ? `TRANSPORTE ${brl(transportAdjustCents)}` : "",
    foodAdjustCents ? `ALIMENTAÇÃO ${brl(foodAdjustCents)}` : "",
  ].filter(Boolean);
  const reviewNote = changes.length || reason ? `REVISÃO: ${[...changes, reason].filter(Boolean).join(" · ")}` : "";
  return { ...row, workingDays: transportDays, ...amounts, reviewNote };
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
    const rules = await loadBenefitRules(database);
    const [rows, { drafts, payment }] = await Promise.all([
      buildCycleRows(database, cycle, companyId, rules),
      loadDrafts(database, month),
    ]);
    return jsonResponse({
      month,
      rules,
      drafts,
      draftPayment: payment,
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
    const rules = await loadBenefitRules(database);
    const rows = (await buildCycleRows(database, cycle, companyId, rules)).map((row) => reviewed(row, body.adjustments));
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
    const adjusted = body.adjustments && typeof body.adjustments === "object" ? (body.adjustments as JsonMap) : {};
    const toUpdate = rows.filter(
      (row) => row.status === "active" && row.generated && row.totalCents > 0 && adjusted[row.employeeId] &&
        (!onlyIds || onlyIds.has(row.employeeId)),
    );
    if (!toGenerate.length && !toUpdate.length) {
      return jsonResponse({ created: 0, updated: 0, skipped });
    }

    const note = `Gerado pelo ciclo ${cycle.start.split("-").reverse().join("/")} a ${cycle.end.split("-").reverse().join("/")}`;
    const statements = [];
    const itemsOf = (row: (typeof rows)[number]) => [
      { type: "alimentacao", mode: "fixed", perDay: 0, days: 0, amount: row.foodCents },
      row.transportTotalCents
        ? { type: "mobilidade", mode: "fixed", perDay: 0, days: row.workingDays, amount: row.transportCents }
        : { type: "mobilidade", mode: "per_day", perDay: row.transportPerDayCents, days: row.workingDays, amount: row.transportCents },
    ].filter((item) => item.amount > 0);
    const insertItems = (benefitId: string, items: ReturnType<typeof itemsOf>) => {
      for (const item of items) {
        statements.push(
          database
            .prepare(
              `INSERT INTO hr_benefit_items
                (id, benefit_id, type, amount_mode, per_day_rate_cents, working_days,
                 amount_cents, discount_cents, created_by, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, CURRENT_TIMESTAMP)`,
            )
            .bind(crypto.randomUUID(), benefitId, item.type, item.mode, item.perDay, item.days, item.amount, actor.id),
        );
      }
    };
    for (const row of toUpdate) {
      const benefitId = row.generated!.id;
      const items = itemsOf(row);
      const base = row.generated!.notes.split(" · REVISÃO:")[0].split(" · ")[0] || note;
      const notes = [base, row.reviewNote, row.benefitNotes].filter(Boolean).join(" · ").slice(0, 500);
      statements.push(
        database
          .prepare(
            `UPDATE hr_benefits SET type=?2, amount_cents=?3, gross_cents=?3, discount_cents=0, notes=?4,
               updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
             WHERE id=?1 AND origin='ciclo'`,
          )
          .bind(benefitId, items.length === 1 ? items[0].type : "multiplo", row.totalCents, notes, actor.id, actorName(actor)),
        database.prepare("DELETE FROM hr_benefit_items WHERE benefit_id=?1").bind(benefitId),
      );
      insertItems(benefitId, items);
    }
    for (const row of toGenerate) {
      const benefitId = crypto.randomUUID();
      const items = itemsOf(row);
      const headerType = items.length === 1 ? items[0].type : "multiplo";
      const notes = [note, row.reviewNote, row.benefitNotes].filter(Boolean).join(" · ").slice(0, 500);
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
            // Formato de recebimento do cadastro; sem ele, o escolhido ao gerar.
            row.benefitPaymentMethod || paymentMethod,
            row.totalCents,
            paymentDate,
            notes,
            actor.id,
            actorName(actor),
          ),
      );
      insertItems(benefitId, items);
    }
    // Gerado/atualizado: o rascunho dele deixa de valer.
    for (const row of [...toGenerate, ...toUpdate]) {
      statements.push(database.prepare("DELETE FROM hr_settings WHERE key=?1").bind(draftKey(cycle.month, row.employeeId)));
    }
    // Tudo ou nada: se outra geração simultânea já criou algum lançamento,
    // o índice único derruba o batch inteiro e nada fica pela metade.
    await database.batch(statements);
    return jsonResponse({ created: toGenerate.length, updated: toUpdate.length, skipped }, 201);
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

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR AS REGRAS DE BENEFÍCIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const body = (await request.json()) as JsonMap;
    const rules = parseBenefitRules(body.rules);
    const database = await getD1();
    await database
      .prepare(
        `INSERT INTO hr_settings (key, value_json, updated_by, updated_by_name, updated_at)
         VALUES ('benefit_rules', ?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by,
           updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at`,
      )
      .bind(JSON.stringify(rules), actor.id, actorName(actor), new Date().toISOString())
      .run();
    return jsonResponse({ saved: true, rules });
  } catch (error) {
    console.error("Não foi possível salvar as regras de benefícios.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR AS REGRAS DE BENEFÍCIOS." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REVISAR O CICLO DE BENEFÍCIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    let key = "";
    let value: string | null = null;
    if (body.payment && typeof body.payment === "object") {
      const input = body.payment as JsonMap;
      const paymentMethod = safeText(input.paymentMethod, 20);
      const paymentDate = safeText(input.paymentDate, 10);
      if (paymentMethod && !isOneOf(BENEFIT_PAYMENT_METHODS, paymentMethod)) {
        return jsonResponse({ error: "SELECIONE UMA FORMA DE PAGAMENTO VÁLIDA." }, 400);
      }
      if (paymentDate && !DATE_PATTERN.test(paymentDate)) {
        return jsonResponse({ error: "INFORME UMA DATA DE PAGAMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
      }
      key = draftKey(month, PAYMENT_DRAFT);
      value = JSON.stringify({ paymentMethod, paymentDate });
    } else {
      const employeeId = safeText(body.employeeId, 80);
      if (!employeeId || employeeId === PAYMENT_DRAFT) return jsonResponse({ error: "FUNCIONÁRIO INVÁLIDO." }, 400);
      key = draftKey(month, employeeId);
      const draft = parseDraft(body.review);
      value = draft ? JSON.stringify(draft) : null;
    }
    const database = await getD1();
    if (value === null) {
      await database.prepare("DELETE FROM hr_settings WHERE key=?1").bind(key).run();
    } else {
      await database
        .prepare(
          `INSERT INTO hr_settings (key, value_json, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by,
             updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at`,
        )
        .bind(key, value, actor.id, actorName(actor), new Date().toISOString())
        .run();
    }
    return jsonResponse({ saved: true });
  } catch (error) {
    console.error("Não foi possível salvar a revisão do ciclo de benefícios.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A REVISÃO DO CICLO." }, 500);
  }
}
