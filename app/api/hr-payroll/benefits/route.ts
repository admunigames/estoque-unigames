import { getD1 } from "../../../../db";
import { hasCompany } from "../../../lib/access-scope";
import { actingStoreResolver } from "../../../lib/acting-store";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import {
  benefitTotalsFromItems,
  headerBenefitType,
  parseBenefitItems,
  type ParsedBenefitItem,
} from "../../../lib/hr-benefits";
import {
  BENEFIT_PAYMENT_METHODS,
  BENEFIT_TYPES,
  canManagePayroll,
  DATE_PATTERN,
  MONTH_PATTERN,
  actorName,
  identity,
  isOneOf,
  jsonResponse,
  loadEmployeeForMonth,
  safeText,
  sameOrigin,
  workingDaysForEmployee,
  type JsonMap,
} from "../shared";

// Benefícios por competência. Um lançamento pode ter VÁRIOS tipos ao mesmo
// tempo (alimentação + mobilidade + ...), cada um com valor e desconto
// próprios — as linhas ficam em hr_benefit_items e os totais do cabeçalho
// (bruto, desconto, líquido) são desnormalizados a partir delas no mesmo
// batch. Vários lançamentos do mesmo funcionário no mesmo mês continuam
// permitidos (sem índice único). A Folha lê o total líquido do mês
// (loadMonthBenefits: netCents = Σ amount_cents).
// Status PAGO / A PAGAR (migration 0141): paid_at vazio = A PAGAR; o PATCH
// marca/desmarca em lote gravando quem e quando. Interno do RH: login com
// loja vinculada não acessa (mesmo com payroll:manage).

// Lojas do lançamento vistas pela lista: ATUANTE no mês da competência
// (calculada na hora, mesma regra do Comissionamento) e de ADMISSÃO.
function payrollGuard(request: Request, deniedMessage: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  const storeLogin = actor.role !== "admin" && hasCompany(request.headers.get("x-unigames-company-id") || "");
  if (!canManagePayroll(actor) || storeLogin) return { error: jsonResponse({ error: deniedMessage }, 403) };
  if (request.method !== "GET" && !sameOrigin(request)) {
    return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  }
  return { actor };
}

type BenefitRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  month: string;
  type: string;
  paymentMethod: string;
  amountCents: number;
  grossCents: number;
  discountCents: number;
  paymentDate: string;
  origin: string;
  notes: string;
  paidAt: string;
  paidBy: string;
  paidByName: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

type BenefitItemRow = {
  id: string;
  benefitId: string;
  type: string;
  amountMode: string;
  perDayRateCents: number;
  workingDays: number;
  amountCents: number;
  discountCents: number;
};

const BENEFIT_COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, month, type,
  payment_method AS paymentMethod, amount_cents AS amountCents, gross_cents AS grossCents,
  discount_cents AS discountCents, payment_date AS paymentDate, origin,
  notes, paid_at AS paidAt, paid_by AS paidBy, paid_by_name AS paidByName, created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

const BENEFIT_ITEM_COLUMNS = `id, benefit_id AS benefitId, type, amount_mode AS amountMode,
  per_day_rate_cents AS perDayRateCents, working_days AS workingDays,
  amount_cents AS amountCents, discount_cents AS discountCents`;

export async function GET(request: Request) {
  const guard = payrollGuard(request, "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR OS BENEFÍCIOS.");
  if (guard.error) return guard.error;

  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const employeeId = safeText(url.searchParams.get("employeeId"), 80);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const actingCompanyId = safeText(url.searchParams.get("actingCompanyId"), 80);
  const admissionCompanyId = safeText(url.searchParams.get("admissionCompanyId"), 80);
  const type = safeText(url.searchParams.get("type"), 20);
  const paidFrom = safeText(url.searchParams.get("paymentFrom"), 10);
  const paidTo = safeText(url.searchParams.get("paymentTo"), 10);
  const status = safeText(url.searchParams.get("status"), 10);
  if (month && !MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  if (type && !isOneOf(BENEFIT_TYPES, type)) {
    return jsonResponse({ error: "TIPO DE BENEFÍCIO INVÁLIDO." }, 400);
  }
  if ((paidFrom && !DATE_PATTERN.test(paidFrom)) || (paidTo && !DATE_PATTERN.test(paidTo))) {
    return jsonResponse({ error: "INFORME DATAS DE PAGAMENTO VÁLIDAS (AAAA-MM-DD)." }, 400);
  }
  if (status && status !== "pago" && status !== "a_pagar") {
    return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const params: string[] = [];
    for (const [column, value] of [
      ["month", month],
      ["employee_id", employeeId],
      ["company_id", companyId],
    ] as Array<[string, string]>) {
      if (!value) continue;
      params.push(value);
      conditions.push(`${column}=?${params.length}`);
    }
    // Filtro por tipo: o lançamento entra se QUALQUER linha for do tipo.
    if (type) {
      params.push(type);
      conditions.push(
        `EXISTS (SELECT 1 FROM hr_benefit_items bi WHERE bi.benefit_id = hr_benefits.id AND bi.type = ?${params.length})`,
      );
    }
    // Data de pagamento DE/ATÉ: lançamento sem data fica de fora.
    if (paidFrom || paidTo) conditions.push("payment_date <> ''");
    if (paidFrom) {
      params.push(paidFrom);
      conditions.push(`payment_date >= ?${params.length}`);
    }
    if (paidTo) {
      params.push(paidTo);
      conditions.push(`payment_date <= ?${params.length}`);
    }
    if (status) conditions.push(status === "pago" ? "paid_at <> ''" : "paid_at = ''");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(
        `SELECT ${BENEFIT_COLUMNS} FROM hr_benefits ${where}
         ORDER BY month DESC, employee_name ASC, created_at ASC`,
      )
      .bind(...params)
      .all<BenefitRow>();
    const benefits = result.results ?? [];

    const itemsByBenefit = new Map<string, BenefitItemRow[]>();
    if (benefits.length) {
      const placeholders = benefits.map((_row, index) => `?${index + 1}`).join(",");
      const itemsResult = await database
        .prepare(
          `SELECT ${BENEFIT_ITEM_COLUMNS} FROM hr_benefit_items
           WHERE benefit_id IN (${placeholders}) ORDER BY created_at ASC`,
        )
        .bind(...benefits.map((row) => row.id))
        .all<BenefitItemRow>();
      for (const item of itemsResult.results ?? []) {
        const list = itemsByBenefit.get(item.benefitId) ?? [];
        list.push(item);
        itemsByBenefit.set(item.benefitId, list);
      }
    }

    const [stores, companies] = benefits.length
      ? await Promise.all([actingStoreResolver(database), loadCompanyList(database)])
      : [null, []];
    const nameOf = (store: { companyId: string; companyName: string } | null | undefined, fallback: string) =>
      (store && (companies.find((company) => company.id === store.companyId)?.name ?? store.companyName)) || fallback;
    const rows = benefits
      .map((row) => {
        const acting = stores?.acting(row.employeeId, row.month);
        const admission = stores?.admission(row.employeeId);
        return {
          ...row,
          // Funcionário excluído do cadastro: fica a loja gravada no lançamento.
          actingCompanyId: acting?.companyId || row.companyId,
          actingCompanyName: nameOf(acting, row.companyName),
          admissionCompanyId: admission?.companyId || row.companyId,
          admissionCompanyName: nameOf(admission, row.companyName),
          items: itemsByBenefit.get(row.id) ?? [],
        };
      })
      .filter(
        (row) =>
          (!actingCompanyId || row.actingCompanyId === actingCompanyId) &&
          (!admissionCompanyId || row.admissionCompanyId === admissionCompanyId),
      );
    const totalCents = rows.reduce((sum, row) => sum + Number(row.amountCents || 0), 0);
    const totalGrossCents = rows.reduce((sum, row) => sum + Number(row.grossCents || 0), 0);
    const totalDiscountCents = rows.reduce((sum, row) => sum + Number(row.discountCents || 0), 0);
    return jsonResponse({ benefits: rows, totalCents, totalGrossCents, totalDiscountCents });
  } catch (error) {
    console.error("Não foi possível carregar os benefícios.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS BENEFÍCIOS." }, 500);
  }
}

export async function POST(request: Request) {
  const guard = payrollGuard(request, "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR BENEFÍCIOS.");
  if (guard.error) return guard.error;
  const { actor } = guard;

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const month = safeText(body.month, 7);
    const paymentMethod = safeText(body.paymentMethod, 20);
    const paymentDate = safeText(body.paymentDate, 10);
    const notes = safeText(body.notes, 500);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }
    if (!isOneOf(BENEFIT_PAYMENT_METHODS, paymentMethod)) {
      return jsonResponse({ error: "SELECIONE UMA FORMA DE PAGAMENTO VÁLIDA." }, 400);
    }
    if (paymentDate && !DATE_PATTERN.test(paymentDate)) {
      return jsonResponse({ error: "INFORME UMA DATA DE PAGAMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
    }

    const database = await getD1();
    // Loja atuante do funcionário NESTE mês (vai para a DRE do mês).
    const employee = await loadEmployeeForMonth(database, employeeId, month);
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

    // Benefício pago por dia trabalhado: dias exatos do ciclo 20→19 da
    // competência pela escala do funcionário (5x2 seg–sex, 6x1 seg–sáb).
    const { workingDays } = workingDaysForEmployee(employee, month);

    const { items, error: itemsError } = parseBenefitItems(
      body.items,
      { type: body.type, amountCents: body.amountCents, discountCents: body.discountCents },
      { workingDays },
    );
    if (itemsError) return jsonResponse({ error: itemsError }, 400);

    const totals = benefitTotalsFromItems(items);
    if (totals.netCents <= 0) {
      return jsonResponse({ error: "O VALOR LÍQUIDO DO LANÇAMENTO PRECISA SER MAIOR QUE ZERO." }, 400);
    }
    const headerType = headerBenefitType(items);

    let benefitId = editId;
    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_benefits WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "BENEFÍCIO NÃO ENCONTRADO." }, 404);
    } else {
      benefitId = crypto.randomUUID();
    }

    const header = editId
      ? database
          .prepare(
            `UPDATE hr_benefits
             SET employee_id=?1, employee_name=?2, company_id=?3, company_name=?4, month=?5,
                 type=?6, payment_method=?7, amount_cents=?8, gross_cents=?9, discount_cents=?10,
                 payment_date=?11, notes=?12, updated_by=?13, updated_by_name=?14,
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=?15`,
          )
          .bind(
            employeeId,
            employee.fullName,
            employee.companyId,
            employee.companyName,
            month,
            headerType,
            paymentMethod,
            totals.netCents,
            totals.grossCents,
            totals.discountCents,
            paymentDate,
            notes,
            actor.id,
            actorName(actor),
            benefitId,
          )
      : database
          .prepare(
            `INSERT INTO hr_benefits
              (id, employee_id, employee_name, company_id, company_name, month, type, payment_method,
               amount_cents, gross_cents, discount_cents, payment_date, notes, created_by,
               created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, CURRENT_TIMESTAMP,
                     ?14, ?15, CURRENT_TIMESTAMP)`,
          )
          .bind(
            benefitId,
            employeeId,
            employee.fullName,
            employee.companyId,
            employee.companyName,
            month,
            headerType,
            paymentMethod,
            totals.netCents,
            totals.grossCents,
            totals.discountCents,
            paymentDate,
            notes,
            actor.id,
            actorName(actor),
          );

    // Cabeçalho + troca completa das linhas no mesmo batch: os totais
    // desnormalizados e as linhas que os originam nunca divergem.
    await database.batch([
      header,
      database.prepare("DELETE FROM hr_benefit_items WHERE benefit_id=?1").bind(benefitId),
      ...items.map((item: ParsedBenefitItem) =>
        database
          .prepare(
            `INSERT INTO hr_benefit_items
              (id, benefit_id, type, amount_mode, per_day_rate_cents, working_days,
               amount_cents, discount_cents, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)`,
          )
          .bind(
            crypto.randomUUID(),
            benefitId,
            item.type,
            item.amountMode,
            item.perDayRateCents,
            item.workingDays,
            item.amountCents,
            item.discountCents,
            actor.id,
          ),
      ),
    ]);

    return jsonResponse(
      editId ? { updated: true, id: benefitId } : { created: true, id: benefitId },
      editId ? 200 : 201,
    );
  } catch (error) {
    console.error("Não foi possível salvar o benefício.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O BENEFÍCIO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const guard = payrollGuard(request, "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR BENEFÍCIOS.");
  if (guard.error) return guard.error;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "BENEFÍCIO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    // Sem FK no banco (convenção do projeto): a cascata é feita aqui.
    await database.batch([
      database.prepare("DELETE FROM hr_benefit_items WHERE benefit_id=?1").bind(id),
      database.prepare("DELETE FROM hr_benefits WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o benefício.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O BENEFÍCIO." }, 500);
  }
}

// MARCAR COMO PAGO / DESMARCAR, um ou vários: { ids: [...], paid: true|false }.
// Marcar não sobrescreve quem já tinha pago (guarda o primeiro registro).
export async function PATCH(request: Request) {
  const guard = payrollGuard(request, "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR BENEFÍCIOS.");
  if (guard.error) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json()) as JsonMap;
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((id) => safeText(id, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM LANÇAMENTO." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELECIONE NO MÁXIMO 500 LANÇAMENTOS POR VEZ." }, 400);
    if (typeof body.paid !== "boolean") return jsonResponse({ error: "INFORME SE É PARA MARCAR OU DESMARCAR." }, 400);
    const database = await getD1();
    const placeholders = ids.map((_id, index) => `?${index + 4}`).join(",");
    await (body.paid
      ? database
          .prepare(
            `UPDATE hr_benefits SET paid_at=?1, paid_by=?2, paid_by_name=?3
             WHERE paid_at = '' AND id IN (${placeholders})`,
          )
          .bind(new Date().toISOString(), actor.id, actorName(actor), ...ids)
      : database
          .prepare(
            `UPDATE hr_benefits SET paid_at=?1, paid_by=?2, paid_by_name=?3 WHERE id IN (${placeholders})`,
          )
          .bind("", "", "", ...ids)
    ).run();
    return jsonResponse({ updated: ids.length, paid: body.paid });
  } catch (error) {
    console.error("Não foi possível alterar o status dos benefícios.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ALTERAR O STATUS DOS BENEFÍCIOS." }, 500);
  }
}
