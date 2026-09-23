import { getD1 } from "../../../../db";
import { isValidCnpj } from "../../../lib/br-documents";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import {
  CANDIDATE_COLUMNS,
  DATE_PATTERN,
  actorName,
  boolToInt,
  canManageRecruitment,
  canViewRecruitment,
  centsValue,
  identity,
  isStatusValid,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type CandidateRow,
  type Identity,
  type JsonMap,
} from "../shared";

// Candidato — entidade única que carrega o status e os dados de TODAS as
// etapas do pipeline (não tabelas separadas por etapa). O front-end sempre
// envia o registro inteiro a cada salvamento (mesmo padrão de
// app/api/hr-store-tracking/store/route.ts), e este handler decide sozinho
// se houve mudança de status (grava em hr_recruitment_status_history e,
// quando o novo status é "contratado", cria automaticamente um
// hr_employees vinculado — decisão de arquitetura confirmada com o usuário).

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RECRUTAMENTO E SELEÇÃO." }, 403);
  }

  const url = new URL(request.url);
  const status = safeText(url.searchParams.get("status"), 30);
  if (status && !isStatusValid(status)) {
    return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const where = status ? "WHERE status=?1" : "";
    const statement = database.prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM hr_recruitment_candidates ${where}
       ORDER BY interview_date DESC, created_at DESC`,
    );
    const result = await (status ? statement.bind(status) : statement).all<CandidateRow>();
    return jsonResponse({ candidates: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os candidatos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS CANDIDATOS." }, 500);
  }
}

function dateOrEmpty(value: unknown) {
  const text = safeText(value, 10);
  return text && DATE_PATTERN.test(text) ? text : "";
}

// Só MONTA o INSERT (não executa) — quem chama precisa rodar esse statement
// no mesmo database.batch() do UPDATE do candidato que grava o vínculo
// (hr_employee_id), pra que a criação do funcionário e a gravação do
// vínculo sejam atômicas. Sem isso, uma falha no UPDATE logo após o INSERT
// (ou um duplo clique em "Salvar") deixaria um hr_employees órfão e criaria
// outro a cada nova tentativa, já que hr_employee_id nunca teria sido
// persistido no candidato.
async function buildHiredEmployeeInsert(
  database: Database,
  candidate: { fullName: string; desiredRole: string; admissionDate: string; admissionCompanyId: string },
  actor: Identity,
) {
  let companyName = "";
  if (candidate.admissionCompanyId === "assistencia") {
    companyName = "Assistência";
  } else if (candidate.admissionCompanyId) {
    const companies = await loadCompanyList(database);
    const company = companies.find((item) => item.id === candidate.admissionCompanyId);
    companyName = company ? company.name : "";
  }
  const employeeId = crypto.randomUUID();
  const statement = database
    .prepare(
      `INSERT INTO hr_employees
        (id, full_name, admission_date, company_id, company_name, role_title, status,
         created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)`,
    )
    .bind(
      employeeId,
      candidate.fullName,
      candidate.admissionDate,
      candidate.admissionCompanyId,
      companyName,
      candidate.desiredRole,
      actor.id,
      actorName(actor),
    );
  return { employeeId, statement };
}

type Database = Awaited<ReturnType<typeof getD1>>;

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CANDIDATOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const fullName = safeText(body.fullName, 160);
    const status = safeText(body.status, 30) || "selecionado_entrevista";
    const statusNote = safeText(body.statusNote, 2000);

    if (!fullName) return jsonResponse({ error: "INFORME O NOME DO CANDIDATO." }, 400);
    if (!isStatusValid(status)) return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);

    const fields = {
      desiredRole: safeText(body.desiredRole, 120),
      interviewDate: dateOrEmpty(body.interviewDate),
      interviewTime: safeText(body.interviewTime, 5),
      scriptSent: boolToInt(body.scriptSent),
      interviewResult: safeText(body.interviewResult, 20),
      interviewResultReason: safeText(body.interviewResultReason, 2000),
      testScriptSent: boolToInt(body.testScriptSent),
      testConfirmed: boolToInt(body.testConfirmed),
      cancelledAt: dateOrEmpty(body.cancelledAt),
      cancelledReason: safeText(body.cancelledReason, 2000),
      kitDelivered: boolToInt(body.kitDelivered),
      kitDeliveredDate: dateOrEmpty(body.kitDeliveredDate),
      trainingStartDate: dateOrEmpty(body.trainingStartDate),
      admissionDate: dateOrEmpty(body.admissionDate),
      admissionCompanyId: safeText(body.admissionCompanyId, 80),
      admissionCompanyName: safeText(body.admissionCompanyName, 160),
      fixedUnitId: safeText(body.fixedUnitId, 80),
      fixedUnitName: safeText(body.fixedUnitName, 160),
      uniformSent: boolToInt(body.uniformSent),
      uniformSentDate: dateOrEmpty(body.uniformSentDate),
      system1Done: boolToInt(body.system1Done),
      system1Date: dateOrEmpty(body.system1Date),
      system2Done: boolToInt(body.system2Done),
      system2Date: dateOrEmpty(body.system2Date),
      system3Done: boolToInt(body.system3Done),
      system3Date: dateOrEmpty(body.system3Date),
      ifoodDone: boolToInt(body.ifoodDone),
      ifoodDate: dateOrEmpty(body.ifoodDate),
      benefitsIncluded: boolToInt(body.benefitsIncluded),
      benefitsCalculated: boolToInt(body.benefitsCalculated),
      benefitsDate: dateOrEmpty(body.benefitsDate),
      facepontoDone: boolToInt(body.facepontoDone),
      facepontoDate: dateOrEmpty(body.facepontoDate),
      payjoyDone: boolToInt(body.payjoyDone),
      payjoyDate: dateOrEmpty(body.payjoyDate),
      birthdayListAdded: boolToInt(body.birthdayListAdded),
      birthdayListDate: dateOrEmpty(body.birthdayListDate),
      photoTaken: boolToInt(body.photoTaken),
      asoRequested: boolToInt(body.asoRequested),
      asoClinic: safeText(body.asoClinic, 160),
      asoValueCents: centsValue(body.asoValueCents ?? 0),
      asoDate: dateOrEmpty(body.asoDate),
      asoClinicCnpj: safeText(body.asoClinicCnpj, 30).replace(/\D+/g, ""),
      shoppingRegistered: boolToInt(body.shoppingRegistered),
      admissionDocsDriveLink: safeText(body.admissionDocsDriveLink, 500),
      dentalPlanIncluded: boolToInt(body.dentalPlanIncluded),
      dentalPlanDate: dateOrEmpty(body.dentalPlanDate),
      referencesChecked: boolToInt(body.referencesChecked),
      integrationMeetingDone: boolToInt(body.integrationMeetingDone),
      integrationTermSigned: boolToInt(body.integrationTermSigned),
      integrationMeetingTranscript: safeText(body.integrationMeetingTranscript, 20000),
    };

    if (fields.interviewResult && !["aprovado", "reprovado"].includes(fields.interviewResult)) {
      return jsonResponse({ error: "RESULTADO DA ENTREVISTA INVÁLIDO." }, 400);
    }
    if (fields.asoClinicCnpj && !isValidCnpj(fields.asoClinicCnpj)) {
      return jsonResponse({ error: "INFORME UM CNPJ VÁLIDO PARA A CLÍNICA DO ASO." }, 400);
    }
    if (status === "contratado" && !fields.admissionDate) {
      return jsonResponse({ error: "INFORME A DATA DE ADMISSÃO PARA CONTRATAR O CANDIDATO." }, 400);
    }
    if (status === "contratado" && !fields.admissionCompanyId) {
      return jsonResponse({ error: "INFORME A LOJA DE ADMISSÃO PARA CONTRATAR O CANDIDATO." }, 400);
    }

    const database = await getD1();

    if (editId) {
      const existing = await database
        .prepare("SELECT status, hr_employee_id AS hrEmployeeId FROM hr_recruitment_candidates WHERE id=?1")
        .bind(editId)
        .first<{ status: string; hrEmployeeId: string }>();
      if (!existing) return jsonResponse({ error: "CANDIDATO NÃO ENCONTRADO." }, 404);

      let hrEmployeeId = existing.hrEmployeeId;
      let hiredEmployeeInsert: Awaited<ReturnType<typeof buildHiredEmployeeInsert>>["statement"] | null = null;
      if (status === "contratado" && !hrEmployeeId) {
        const built = await buildHiredEmployeeInsert(
          database,
          {
            fullName,
            desiredRole: fields.desiredRole,
            admissionDate: fields.admissionDate,
            admissionCompanyId: fields.admissionCompanyId,
          },
          actor,
        );
        hrEmployeeId = built.employeeId;
        hiredEmployeeInsert = built.statement;
      }

      const updateCandidateStatement = database
        .prepare(
          `UPDATE hr_recruitment_candidates SET
            full_name=?1, desired_role=?2, status=?3,
            interview_date=?4, interview_time=?5, script_sent=?6,
            interview_result=?7, interview_result_reason=?8,
            test_script_sent=?9, test_confirmed=?10, cancelled_at=?11, cancelled_reason=?12,
            kit_delivered=?13, kit_delivered_date=?14, training_start_date=?15, admission_date=?16,
            admission_company_id=?17, admission_company_name=?18, fixed_unit_id=?19, fixed_unit_name=?20,
            uniform_sent=?21, uniform_sent_date=?22,
            system1_done=?23, system1_date=?24, system2_done=?25, system2_date=?26,
            system3_done=?27, system3_date=?28,
            ifood_done=?29, ifood_date=?30,
            benefits_included=?31, benefits_calculated=?32, benefits_date=?33,
            faceponto_done=?34, faceponto_date=?35, payjoy_done=?36, payjoy_date=?37,
            birthday_list_added=?38, birthday_list_date=?39, photo_taken=?40,
            aso_requested=?41, aso_clinic=?42, aso_value_cents=?43,
            shopping_registered=?44, admission_docs_drive_link=?45,
            dental_plan_included=?46, dental_plan_date=?47, references_checked=?48,
            integration_meeting_done=?49, integration_term_signed=?50, integration_meeting_transcript=?51,
            hr_employee_id=?52,
            updated_by=?53, updated_by_name=?54, updated_at=CURRENT_TIMESTAMP,
            aso_date=?56, aso_clinic_cnpj=?57
           WHERE id=?55`,
        )
        .bind(
          fullName,
          fields.desiredRole,
          status,
          fields.interviewDate,
          fields.interviewTime,
          fields.scriptSent,
          fields.interviewResult,
          fields.interviewResultReason,
          fields.testScriptSent,
          fields.testConfirmed,
          fields.cancelledAt,
          fields.cancelledReason,
          fields.kitDelivered,
          fields.kitDeliveredDate,
          fields.trainingStartDate,
          fields.admissionDate,
          fields.admissionCompanyId,
          fields.admissionCompanyName,
          fields.fixedUnitId,
          fields.fixedUnitName,
          fields.uniformSent,
          fields.uniformSentDate,
          fields.system1Done,
          fields.system1Date,
          fields.system2Done,
          fields.system2Date,
          fields.system3Done,
          fields.system3Date,
          fields.ifoodDone,
          fields.ifoodDate,
          fields.benefitsIncluded,
          fields.benefitsCalculated,
          fields.benefitsDate,
          fields.facepontoDone,
          fields.facepontoDate,
          fields.payjoyDone,
          fields.payjoyDate,
          fields.birthdayListAdded,
          fields.birthdayListDate,
          fields.photoTaken,
          fields.asoRequested,
          fields.asoClinic,
          fields.asoValueCents,
          fields.shoppingRegistered,
          fields.admissionDocsDriveLink,
          fields.dentalPlanIncluded,
          fields.dentalPlanDate,
          fields.referencesChecked,
          fields.integrationMeetingDone,
          fields.integrationTermSigned,
          fields.integrationMeetingTranscript,
          hrEmployeeId,
          actor.id,
          actorName(actor),
          editId,
          fields.asoDate,
          fields.asoClinicCnpj,
        );

      const statements = [];
      if (hiredEmployeeInsert) statements.push(hiredEmployeeInsert);
      statements.push(updateCandidateStatement);
      if (status !== existing.status) {
        statements.push(
          database
            .prepare(
              `INSERT INTO hr_recruitment_status_history
                (id, candidate_id, from_status, to_status, note, changed_by, changed_by_name, changed_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)`,
            )
            .bind(crypto.randomUUID(), editId, existing.status, status, statusNote, actor.id, actorName(actor)),
        );
      }
      // Uma única transação: se a criação do hr_employees, a gravação do
      // vínculo (hr_employee_id) no candidato ou o histórico falharem, TUDO
      // é revertido junto — evita funcionário órfão ou duplicado em caso de
      // erro parcial ou nova tentativa (ver buildHiredEmployeeInsert).
      await database.batch(statements);

      return jsonResponse({ updated: true, id: editId, hrEmployeeId });
    }

    if (status === "contratado") {
      return jsonResponse(
        { error: "UM NOVO CANDIDATO NÃO PODE COMEÇAR JÁ COMO CONTRATADO. AVANCE PELO PIPELINE." },
        400,
      );
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_recruitment_candidates
          (id, full_name, desired_role, status, interview_date, interview_time, script_sent,
           interview_result, interview_result_reason, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP, ?10, ?11, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        fullName,
        fields.desiredRole,
        status,
        fields.interviewDate,
        fields.interviewTime,
        fields.scriptSent,
        fields.interviewResult,
        fields.interviewResultReason,
        actor.id,
        actorName(actor),
      )
      .run();

    await database
      .prepare(
        `INSERT INTO hr_recruitment_status_history
          (id, candidate_id, from_status, to_status, note, changed_by, changed_by_name, changed_at)
         VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)`,
      )
      .bind(crypto.randomUUID(), id, status, statusNote, actor.id, actorName(actor))
      .run();

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o candidato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O CANDIDATO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR CANDIDATOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "CANDIDATO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare(
        `SELECT hr_employee_id AS hrEmployeeId, integration_term_r2_key AS integrationTermR2Key,
                integration_print_r2_key AS integrationPrintR2Key
         FROM hr_recruitment_candidates WHERE id=?1`,
      )
      .bind(id)
      .first<{ hrEmployeeId: string; integrationTermR2Key: string; integrationPrintR2Key: string }>();
    if (!existing) return jsonResponse({ error: "CANDIDATO NÃO ENCONTRADO." }, 404);
    if (existing.hrEmployeeId) {
      return jsonResponse(
        { error: "ESTE CANDIDATO JÁ FOI CONTRATADO E TEM UM FUNCIONÁRIO VINCULADO. MARQUE COMO CANCELADO EM VEZ DE EXCLUIR." },
        409,
      );
    }
    await database.batch([
      database.prepare("DELETE FROM hr_recruitment_status_history WHERE candidate_id=?1").bind(id),
      database.prepare("DELETE FROM hr_recruitment_test_payments WHERE candidate_id=?1").bind(id),
      database.prepare("DELETE FROM hr_recruitment_candidates WHERE id=?1").bind(id),
    ]);
    if (existing.integrationTermR2Key || existing.integrationPrintR2Key) {
      const { documentsBucket } = await import("../../documents/shared");
      const bucket = await documentsBucket();
      if (existing.integrationTermR2Key) await bucket.delete(existing.integrationTermR2Key).catch(() => undefined);
      if (existing.integrationPrintR2Key) await bucket.delete(existing.integrationPrintR2Key).catch(() => undefined);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o candidato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O CANDIDATO." }, 500);
  }
}
