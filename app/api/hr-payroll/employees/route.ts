import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { checklistPendingCount } from "../../../lib/hr-rh";
import { loadCompanyList } from "../../finance/shared";
import {
  canEmployees,
  canManagePayroll,
  canSeeEmployees,
  EMPLOYEE_FINANCIAL_FIELDS,
  centsValue,
  DATE_PATTERN,
  EMPLOYEE_COLUMNS,
  EMPLOYEE_STATUSES,
  actorName,
  deactivateLinkedLogin,
  identity,
  insertTermination,
  isOneOf,
  isValidCpf,
  jsonResponse,
  onlyDigits,
  safeText,
  sameOrigin,
  terminationFields,
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
  if (!canSeeEmployees(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER OS FUNCIONÁRIOS." }, 403);
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
    const financial = canManagePayroll(actor);
    // Checklist demissional pendente do último desligamento (alerta na lista).
    const terminations = await database
      .prepare("SELECT employee_id AS employeeId, checklist_json AS checklistJson FROM hr_terminations ORDER BY termination_date ASC, created_at ASC")
      .all<{ employeeId: string; checklistJson: string }>();
    const pendingByEmployee = new Map<string, number>();
    for (const item of terminations.results ?? []) pendingByEmployee.set(item.employeeId, checklistPendingCount(item.checklistJson));
    const employees = (result.results ?? []).map((source) => {
      const row = { ...source, offboardingPending: source.status === "inactive" ? pendingByEmployee.get(source.id) ?? 0 : 0 };
      if (financial) return row;
      // Sem RH Financeiro: salário, PIX, banco e benefícios não saem do servidor.
      const copy: Record<string, unknown> = { ...row, financialHidden: true };
      for (const field of EMPLOYEE_FINANCIAL_FIELDS) delete copy[field];
      return copy;
    });
    return jsonResponse({ employees });
  } catch (error) {
    console.error("Não foi possível carregar os funcionários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS FUNCIONÁRIOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canEmployees(actor, "create") && !canEmployees(actor, "edit")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR FUNCIONÁRIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    if (!canEmployees(actor, editId ? "edit" : "create")) {
      return jsonResponse({ error: editId ? "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR FUNCIONÁRIOS." : "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR FUNCIONÁRIOS." }, 403);
    }
    const financial = canManagePayroll(actor);
    // Nomes do RH sempre em CAIXA ALTA (pedido do usuário, 2026-10-06).
    const fullName = safeText(body.fullName, 160).toLocaleUpperCase("pt-BR");
    const cpf = onlyDigits(safeText(body.cpf, 20));
    const rg = safeText(body.rg, 30);
    const telefone = safeText(body.telefone, 40);
    const admissionDate = safeText(body.admissionDate, 10);
    const companyId = safeText(body.companyId, 80);
    const roleTitle = safeText(body.roleTitle, 120);
    let pixKey = safeText(body.pixKey, 160);
    let bankName = safeText(body.bankName, 120);
    const status = safeText(body.status, 20) || "active";
    const workSchedule = safeText(body.workSchedule, 10) || "5x2";
    const userId = safeText(body.userId, 80);
    const notes = safeText(body.notes, 500);
    // Link do Drive dos documentos: só http(s), nunca convertido para maiúsculas.
    const driveLink = safeText(body.driveLink, 600);
    if (driveLink && !/^https?:\/\/\S+$/i.test(driveLink)) {
      return jsonResponse({ error: "O LINK DO DRIVE PRECISA COMEÇAR COM https://." }, 400);
    }
    let salaryCents = centsValue(body.salaryCents ?? 0);
    let foodPerDayCents = centsValue(body.foodPerDayCents ?? 0);
    let transportPerDayCents = centsValue(body.transportPerDayCents ?? 0);
    let benefitNotes = safeText(body.benefitNotes, 500);

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
    if (!Number.isFinite(foodPerDayCents) || foodPerDayCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR DE ALIMENTAÇÃO POR DIA VÁLIDO." }, 400);
    }
    if (!Number.isFinite(transportPerDayCents) || transportPerDayCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR DE TRANSPORTE POR DIA VÁLIDO." }, 400);
    }

    const database = await getD1();
    const previousStatus = editId
      ? (await database.prepare("SELECT status FROM hr_employees WHERE id=?1").bind(editId).first<{ status: string }>())?.status
      : "";
    // Só fica INATIVO com data e motivo do desligamento (checklist pode ficar pendente).
    const becomingInactive = status === "inactive" && previousStatus !== "inactive";
    const termination = terminationFields(body.termination);
    if (becomingInactive && termination.error) return jsonResponse({ error: termination.error }, 400);

    let companyName = "";
    if (companyId === "assistencia") {
      // Setor interno tratado como unidade própria na DRE (item 8).
      companyName = "Assistência";
    } else if (companyId) {
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
        .prepare(
          `SELECT id, salary_cents AS salaryCents, pix_key AS pixKey, bank_name AS bankName,
                  food_per_day_cents AS foodPerDayCents, transport_per_day_cents AS transportPerDayCents,
                  benefit_notes AS benefitNotes
           FROM hr_employees WHERE id=?1`,
        )
        .bind(editId)
        .first<{ id: string; salaryCents: number; pixKey: string; bankName: string; foodPerDayCents: number; transportPerDayCents: number; benefitNotes: string }>();
      if (!existing) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
      // Sem RH Financeiro: os dados financeiros ficam como estavam.
      if (!financial) {
        salaryCents = Number(existing.salaryCents) || 0;
        pixKey = existing.pixKey || "";
        bankName = existing.bankName || "";
        foodPerDayCents = Number(existing.foodPerDayCents) || 0;
        transportPerDayCents = Number(existing.transportPerDayCents) || 0;
        benefitNotes = existing.benefitNotes || "";
      }
      const updateStatement = database
        .prepare(
          `UPDATE hr_employees
           SET full_name=?1, cpf=?2, admission_date=?3, company_id=?4, company_name=?5,
               role_title=?6, salary_cents=?7, pix_key=?8, bank_name=?9, status=?10,
               work_schedule=?11, user_id=?12, notes=?13, updated_by=?14, updated_by_name=?15,
               food_per_day_cents=?17, transport_per_day_cents=?18, benefit_notes=?19,
               rg=?20, telefone=?21, drive_link=?22, updated_at=CURRENT_TIMESTAMP
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
          foodPerDayCents,
          transportPerDayCents,
          benefitNotes,
          rg,
          telefone,
          driveLink,
        );
      // Marcado como inativo (desligado): cadastro + desligamento juntos
      // (mesma transação) e o login vinculado é bloqueado na hora.
      await database.batch(becomingInactive
        ? [updateStatement, insertTermination(database, { employeeId: editId, employeeName: fullName, companyId, companyName, ...termination }, actor).statement]
        : [updateStatement]);
      if (status === "inactive") await deactivateLinkedLogin(database, editId).run();
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
      // Rescisão e ASO guardam a loja DA ÉPOCA (histórico do DRE Funcionário);
      // só o nome acompanha a correção do cadastro.
      await database.batch([
        database.prepare("UPDATE hr_terminations SET employee_name=?1 WHERE employee_id=?2").bind(fullName, editId),
        database.prepare("UPDATE hr_aso_exams SET employee_name=?1 WHERE employee_id=?2").bind(fullName, editId),
      ]);
      return jsonResponse({ updated: true, id: editId });
    }

    if (!financial) {
      // Cadastro novo sem RH Financeiro: entra sem dados financeiros.
      salaryCents = 0; pixKey = ""; bankName = ""; foodPerDayCents = 0; transportPerDayCents = 0; benefitNotes = "";
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_employees
          (id, full_name, cpf, admission_date, company_id, company_name, role_title, salary_cents,
           pix_key, bank_name, status, work_schedule, user_id, notes, created_by, created_by_name,
           created_at, updated_by, updated_by_name, updated_at,
           food_per_day_cents, transport_per_day_cents, benefit_notes, rg, telefone, onboarding_started_at, drive_link)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                 CURRENT_TIMESTAMP, ?15, ?16, CURRENT_TIMESTAMP, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
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
        foodPerDayCents,
        transportPerDayCents,
        benefitNotes,
        rg,
        telefone,
        // Funcionário novo recebe a trilha de Onboarding do cargo/loja.
        status === "active" ? new Date().toISOString() : "",
        driveLink,
      )
      .run();
    if (becomingInactive) {
      await database.batch([
        insertTermination(database, { employeeId: id, employeeName: fullName, companyId, companyName, ...termination }, actor).statement,
      ]);
    }
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
  if (!canEmployees(actor, "delete")) {
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
         + (SELECT COUNT(*) FROM hr_commissions WHERE employee_id=?1)
         + (SELECT COUNT(*) FROM hr_terminations WHERE employee_id=?1)
         + (SELECT COUNT(*) FROM hr_aso_exams WHERE employee_id=?1) AS total`,
      )
      .bind(id)
      .first<{ total: number }>();
    if (Number(used?.total ?? 0) > 0) {
      return jsonResponse(
        {
          error:
            "ESTE FUNCIONÁRIO JÁ TEM LANÇAMENTOS DE FOLHA, BENEFÍCIOS, COMISSÃO, RESCISÃO OU ASO. MARQUE-O COMO INATIVO EM VEZ DE EXCLUIR.",
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
