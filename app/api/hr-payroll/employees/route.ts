import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import {
  canManagePayroll,
  centsValue,
  DATE_PATTERN,
  EMPLOYEE_COLUMNS,
  EMPLOYEE_STATUSES,
  actorName,
  identity,
  isOneOf,
  isValidCpf,
  jsonResponse,
  onlyDigits,
  safeText,
  sameOrigin,
  type EmployeeRow,
  type JsonMap,
} from "../shared";

// Cadastro de funcionários — base da Folha, dos Benefícios e do
// Comissionamento. Não tem relação com app_users (contas de login): o
// vínculo é opcional (userId) e serve só para identificar quem também tem
// acesso ao sistema.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  }

  const url = new URL(request.url);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const status = safeText(url.searchParams.get("status"), 20);
  if (status && !isOneOf(EMPLOYEE_STATUSES, status)) {
    return jsonResponse({ error: "SITUAÇÃO INVÁLIDA." }, 400);
  }

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const params: string[] = [];
    if (companyId) {
      params.push(companyId);
      conditions.push(`company_id=?${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status=?${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(`SELECT ${EMPLOYEE_COLUMNS} FROM hr_employees ${where} ORDER BY full_name ASC`)
      .bind(...params)
      .all<EmployeeRow>();
    return jsonResponse({ employees: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os funcionários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS FUNCIONÁRIOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR FUNCIONÁRIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const fullName = safeText(body.fullName, 160);
    const cpf = onlyDigits(safeText(body.cpf, 20));
    const admissionDate = safeText(body.admissionDate, 10);
    const companyId = safeText(body.companyId, 80);
    const roleTitle = safeText(body.roleTitle, 120);
    const pixKey = safeText(body.pixKey, 160);
    const bankName = safeText(body.bankName, 120);
    const status = safeText(body.status, 20) || "active";
    const workSchedule = safeText(body.workSchedule, 10) || "5x2";
    const userId = safeText(body.userId, 80);
    const notes = safeText(body.notes, 500);
    const salaryCents = centsValue(body.salaryCents ?? 0);

    if (!fullName) return jsonResponse({ error: "INFORME O NOME DO FUNCIONÁRIO." }, 400);
    if (cpf && !isValidCpf(cpf)) return jsonResponse({ error: "INFORME UM CPF VÁLIDO." }, 400);
    if (admissionDate && !DATE_PATTERN.test(admissionDate)) {
      return jsonResponse({ error: "INFORME UMA DATA DE ADMISSÃO VÁLIDA (AAAA-MM-DD)." }, 400);
    }
    if (!isOneOf(EMPLOYEE_STATUSES, status)) {
      return jsonResponse({ error: "SITUAÇÃO INVÁLIDA." }, 400);
    }
    if (workSchedule !== "5x2" && workSchedule !== "6x1") {
      return jsonResponse({ error: "ESCALA INVÁLIDA (USE 5x2 OU 6x1)." }, 400);
    }
    if (!Number.isFinite(salaryCents) || salaryCents < 0) {
      return jsonResponse({ error: "INFORME UM SALÁRIO VÁLIDO." }, 400);
    }

    const database = await getD1();

    let companyName = "";
    if (companyId) {
      const companies = await loadCompanyList(database);
      const company = companies.find((item) => item.id === companyId);
      if (!company) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
      companyName = company.name;
    }

    if (userId) {
      const account = await database
        .prepare("SELECT id FROM app_users WHERE id=?1 LIMIT 1")
        .bind(userId)
        .first<{ id: string }>();
      if (!account) return jsonResponse({ error: "CONTA DE ACESSO NÃO ENCONTRADA." }, 400);
    }

    if (cpf) {
      const duplicate = await database
        .prepare("SELECT id FROM hr_employees WHERE cpf=?1 AND id<>?2 LIMIT 1")
        .bind(cpf, editId || "")
        .first<{ id: string }>();
      if (duplicate) {
        return jsonResponse({ error: "JÁ EXISTE UM FUNCIONÁRIO CADASTRADO COM ESSE CPF." }, 409);
      }
    }

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_employees WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_employees
           SET full_name=?1, cpf=?2, admission_date=?3, company_id=?4, company_name=?5,
               role_title=?6, salary_cents=?7, pix_key=?8, bank_name=?9, status=?10,
               work_schedule=?11, user_id=?12, notes=?13, updated_by=?14, updated_by_name=?15,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=?16`,
        )
        .bind(
          fullName,
          cpf,
          admissionDate,
          companyId,
          companyName,
          roleTitle,
          salaryCents,
          pixKey,
          bankName,
          status,
          workSchedule,
          userId,
          notes,
          actor.id,
          actorName(actor),
          editId,
        )
        .run();
      // O nome/loja do funcionário são desnormalizados nos lançamentos —
      // manter os já existentes em sincronia evita relatório com nome antigo.
      await database.batch([
        database
          .prepare("UPDATE hr_payroll_entries SET employee_name=?1, company_id=?2, company_name=?3 WHERE employee_id=?4")
          .bind(fullName, companyId, companyName, editId),
        database
          .prepare("UPDATE hr_benefits SET employee_name=?1, company_id=?2, company_name=?3 WHERE employee_id=?4")
          .bind(fullName, companyId, companyName, editId),
        database
          .prepare("UPDATE hr_commissions SET employee_name=?1, company_id=?2, company_name=?3 WHERE employee_id=?4")
          .bind(fullName, companyId, companyName, editId),
      ]);
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_employees
          (id, full_name, cpf, admission_date, company_id, company_name, role_title, salary_cents,
           pix_key, bank_name, status, work_schedule, user_id, notes, created_by, created_by_name,
           created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                 CURRENT_TIMESTAMP, ?15, ?16, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        fullName,
        cpf,
        admissionDate,
        companyId,
        companyName,
        roleTitle,
        salaryCents,
        pixKey,
        bankName,
        status,
        workSchedule,
        userId,
        notes,
        actor.id,
        actorName(actor),
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o funcionário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O FUNCIONÁRIO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR FUNCIONÁRIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "FUNCIONÁRIO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    // Histórico de folha/benefícios/comissão não pode virar linha órfã: quem
    // saiu da empresa deve ser marcado como INATIVO, não excluído.
    const used = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM hr_payroll_entries WHERE employee_id=?1)
         + (SELECT COUNT(*) FROM hr_benefits WHERE employee_id=?1)
         + (SELECT COUNT(*) FROM hr_commissions WHERE employee_id=?1) AS total`,
      )
      .bind(id)
      .first<{ total: number }>();
    if (Number(used?.total ?? 0) > 0) {
      return jsonResponse(
        {
          error:
            "ESTE FUNCIONÁRIO JÁ TEM LANÇAMENTOS DE FOLHA, BENEFÍCIOS OU COMISSÃO. MARQUE-O COMO INATIVO EM VEZ DE EXCLUIR.",
        },
        409,
      );
    }
    await database.prepare("DELETE FROM hr_employees WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o funcionário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O FUNCIONÁRIO." }, 500);
  }
}
