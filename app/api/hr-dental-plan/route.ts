import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import {
  DENTAL_PLAN_COLUMNS,
  actorName,
  canManageDentalPlan,
  canViewDentalPlan,
  identity,
  isDentalPlanReason,
  isDentalPlanStatus,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type DentalPlanRow,
  type Identity,
  type JsonMap,
} from "./shared";

// RH > Plano Odontológico — listagem (com filtros por status, CNPJ/unidade e
// motivo), criação/edição e exclusão de registros. GET faz LEFT JOIN com
// hr_employees pra trazer CPF e data de nascimento sempre atualizados (nunca
// copiados pra hr_dental_plan).

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewDentalPlan(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O PLANO ODONTOLÓGICO." }, 403);
  }

  try {
    const url = new URL(request.url);
    const status = safeText(url.searchParams.get("status"), 40);
    const reason = safeText(url.searchParams.get("reason"), 20);
    const cnpj = safeText(url.searchParams.get("cnpj"), 32);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (status && isDentalPlanStatus(status)) {
      bindings.push(status);
      conditions.push(`d.status=?${bindings.length}`);
    }
    if (reason && isDentalPlanReason(reason) && reason !== "") {
      bindings.push(reason);
      conditions.push(`d.reason=?${bindings.length}`);
    }
    if (cnpj) {
      bindings.push(cnpj);
      conditions.push(`d.cnpj=?${bindings.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const database = await getD1();
    const query = `
      SELECT ${DENTAL_PLAN_COLUMNS}
      FROM hr_dental_plan d
      LEFT JOIN hr_employees e ON e.id = d.employee_id
      ${where}
      ORDER BY d.employee_name ASC
      LIMIT 1000
    `;
    const result = bindings.length
      ? await database.prepare(query).bind(...bindings).all<DentalPlanRow>()
      : await database.prepare(query).all<DentalPlanRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o plano odontológico.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O PLANO ODONTOLÓGICO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor: Identity = identity(request);
  if (!canManageDentalPlan(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR O PLANO ODONTOLÓGICO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const employeeName = safeText(body.employeeName, 160);
    const unitName = safeText(body.unitName, 200);
    const cnpj = safeText(body.cnpj, 32);
    const status = safeText(body.status, 40);
    const reason = safeText(body.reason, 20);
    const processNumber = safeText(body.processNumber, 80);
    const notes = safeText(body.notes, 2000);

    if (!employeeName) return jsonResponse({ error: "INFORME O COLABORADOR." }, 400);
    if (!isDentalPlanStatus(status)) return jsonResponse({ error: "SITUAÇÃO INVÁLIDA." }, 400);
    if (!isDentalPlanReason(reason)) return jsonResponse({ error: "MOTIVO INVÁLIDO." }, 400);

    const database = await getD1();

    if (employeeId) {
      const employee = await database
        .prepare("SELECT id FROM hr_employees WHERE id=?1 LIMIT 1")
        .bind(employeeId)
        .first<{ id: string }>();
      if (!employee) return jsonResponse({ error: "COLABORADOR NÃO ENCONTRADO." }, 404);
    }

    let recordId = editId;
    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_dental_plan WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_dental_plan
           SET employee_id=?1, employee_name=?2, unit_name=?3, cnpj=?4, status=?5, reason=?6,
               process_number=?7, notes=?8, updated_by=?9, updated_by_name=?10, updated_at=CURRENT_TIMESTAMP
           WHERE id=?11`,
        )
        .bind(
          employeeId,
          employeeName,
          unitName,
          cnpj,
          status,
          reason,
          processNumber,
          notes,
          actor.id,
          actorName(actor),
          editId,
        )
        .run();
    } else {
      recordId = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO hr_dental_plan
            (id, employee_id, employee_name, unit_name, cnpj, status, reason, process_number, notes,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP, ?10, ?11, CURRENT_TIMESTAMP)`,
        )
        .bind(
          recordId,
          employeeId,
          employeeName,
          unitName,
          cnpj,
          status,
          reason,
          processNumber,
          notes,
          actor.id,
          actorName(actor),
        )
        .run();
    }

    return jsonResponse(
      editId ? { updated: true, id: recordId } : { created: true, id: recordId },
      editId ? 200 : 201,
    );
  } catch (error) {
    console.error("Não foi possível salvar o registro do plano odontológico.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O REGISTRO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageDentalPlan(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR REGISTROS DO PLANO ODONTOLÓGICO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "REGISTRO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_dental_plan WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_dental_plan WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o registro do plano odontológico.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O REGISTRO." }, 500);
  }
}
