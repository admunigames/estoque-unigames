import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  actorName,
  canManageRecruitment,
  canViewRecruitment,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type JsonMap,
} from "../shared";

// Acompanhamento de Padrinhos — lista separada, vinculada ao funcionário já
// contratado. Não depende de um candidato específico (o funcionário pode já
// existir sem ter passado pelo pipeline de recrutamento), por isso é uma
// tela própria dentro do mesmo módulo.

type SponsorRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  sponsorName: string;
  informedDate: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName, company_id AS companyId,
  company_name AS companyName, sponsor_name AS sponsorName, informed_date AS informedDate,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RECRUTAMENTO E SELEÇÃO." }, 403);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(`SELECT ${COLUMNS} FROM hr_recruitment_sponsors ORDER BY informed_date DESC, created_at DESC`)
      .all<SponsorRow>();
    return jsonResponse({ sponsors: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os padrinhos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PADRINHOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR PADRINHOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const employeeName = safeText(body.employeeName, 160);
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    const sponsorName = safeText(body.sponsorName, 160);
    const informedDate = safeText(body.informedDate, 10);

    if (!employeeName) return jsonResponse({ error: "INFORME O NOME DO APADRINHADO." }, 400);
    if (informedDate && !DATE_PATTERN.test(informedDate)) {
      return jsonResponse({ error: "INFORME UMA DATA VÁLIDA (AAAA-MM-DD)." }, 400);
    }

    const database = await getD1();
    let recordId = editId;
    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_recruitment_sponsors WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_recruitment_sponsors
           SET employee_id=?1, employee_name=?2, company_id=?3, company_name=?4, sponsor_name=?5,
               informed_date=?6, updated_by=?7, updated_by_name=?8, updated_at=CURRENT_TIMESTAMP
           WHERE id=?9`,
        )
        .bind(employeeId, employeeName, companyId, companyName, sponsorName, informedDate, actor.id, actorName(actor), editId)
        .run();
    } else {
      recordId = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO hr_recruitment_sponsors
            (id, employee_id, employee_name, company_id, company_name, sponsor_name, informed_date,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP, ?8, ?9, CURRENT_TIMESTAMP)`,
        )
        .bind(recordId, employeeId, employeeName, companyId, companyName, sponsorName, informedDate, actor.id, actorName(actor))
        .run();
    }

    return jsonResponse(
      editId ? { updated: true, id: recordId } : { created: true, id: recordId },
      editId ? 200 : 201,
    );
  } catch (error) {
    console.error("Não foi possível salvar o padrinho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O PADRINHO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR PADRINHOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "REGISTRO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_recruitment_sponsors WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.batch([
      database.prepare("DELETE FROM hr_recruitment_sponsor_updates WHERE sponsor_id=?1").bind(id),
      database.prepare("DELETE FROM hr_recruitment_sponsors WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o padrinho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O PADRINHO." }, 500);
  }
}
