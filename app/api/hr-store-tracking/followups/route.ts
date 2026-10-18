import { getD1 } from "../../../../db";
import { addDays } from "../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  actorName,
  canManageStoreTracking,
  canViewStoreTracking,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Acompanhamento POR LIDERADO de uma loja: ciclos de 3 encontros (Semana 1
// e 2 online, Semana 3 presencial). GET devolve os encontros e a equipe
// ativa da loja (para escolher líder e liderado); POST cria ciclo ou salva
// um encontro; DELETE apaga um ciclo inteiro.

const WEEKS = [
  { week: 1, mode: "online" },
  { week: 2, mode: "online" },
  { week: 3, mode: "presencial" },
];

type Row = {
  id: string; companyId: string; leaderName: string; leaderArea: string; memberName: string; cycleStart: string;
  week: number; mode: string; meetingDate: string; topic: string; notes: string; done: number; updatedByName: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canViewStoreTracking(identity(request))) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O ACOMPANHAMENTO DE LOJAS." }, 403);
  }
  const companyId = safeText(new URL(request.url).searchParams.get("companyId"), 80);
  if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
  try {
    const database = await getD1();
    const [rows, team] = await Promise.all([
      database
        .prepare(
          `SELECT id, company_id AS companyId, leader_name AS leaderName, leader_area AS leaderArea,
                  member_name AS memberName, cycle_start AS cycleStart, week, mode, meeting_date AS meetingDate,
                  topic, notes, done, updated_by_name AS updatedByName
           FROM hr_store_followups WHERE company_id=?1 ORDER BY member_name ASC, cycle_start DESC, week ASC`,
        )
        .bind(companyId)
        .all<Row>(),
      database
        .prepare(
          `SELECT full_name AS fullName, role_title AS roleTitle FROM hr_employees
           WHERE company_id=?1 AND status='active' ORDER BY full_name ASC`,
        )
        .bind(companyId)
        .all<{ fullName: string; roleTitle: string }>(),
    ]);
    return jsonResponse({ followups: rows.results ?? [], team: team.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o acompanhamento por liderado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O ACOMPANHAMENTO POR LIDERADO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O ACOMPANHAMENTO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    const database = await getD1();
    const now = new Date().toISOString();

    if (action === "cycle") {
      const companyId = safeText(body.companyId, 80);
      const companyName = safeText(body.companyName, 160);
      const leaderName = safeText(body.leaderName, 160);
      const leaderArea = body.leaderArea === "operacional" ? "operacional" : "comercial";
      const memberName = safeText(body.memberName, 160).toLocaleUpperCase("pt-BR");
      const cycleStart = safeText(body.cycleStart, 10);
      if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
      if (!leaderName) return jsonResponse({ error: "INFORME O LÍDER." }, 400);
      if (!memberName) return jsonResponse({ error: "INFORME O LIDERADO." }, 400);
      if (!DATE_PATTERN.test(cycleStart)) return jsonResponse({ error: "INFORME O INÍCIO DO CICLO." }, 400);
      const existing = await database
        .prepare("SELECT id FROM hr_store_followups WHERE company_id=?1 AND member_name=?2 AND cycle_start=?3 LIMIT 1")
        .bind(companyId, memberName, cycleStart)
        .first<{ id: string }>();
      if (existing) return jsonResponse({ error: "ESTE LIDERADO JÁ TEM UM CICLO COM ESSE INÍCIO." }, 409);
      await database.batch(WEEKS.map(({ week, mode }) =>
        database
          .prepare(
            `INSERT INTO hr_store_followups
              (id, company_id, company_name, leader_name, leader_area, member_name, cycle_start, week, mode, meeting_date,
               created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?11, ?12, ?13)`,
          )
          .bind(crypto.randomUUID(), companyId, companyName, leaderName, leaderArea, memberName, cycleStart, week, mode,
            addDays(cycleStart, (week - 1) * 7), actor.id, actorName(actor), now)));
      return jsonResponse({ created: true }, 201);
    }

    if (action === "meeting") {
      const id = safeText(body.id, 80);
      const meetingDate = safeText(body.meetingDate, 10);
      if (meetingDate && !DATE_PATTERN.test(meetingDate)) return jsonResponse({ error: "INFORME UMA DATA VÁLIDA." }, 400);
      const existing = await database.prepare("SELECT id FROM hr_store_followups WHERE id=?1").bind(id).first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "ENCONTRO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_store_followups SET meeting_date=?1, topic=?2, notes=?3, done=?4, updated_by=?5, updated_by_name=?6,
             updated_at=?7 WHERE id=?8`,
        )
        .bind(meetingDate, safeText(body.topic, 2000), safeText(body.notes, 4000), body.done === true ? 1 : 0,
          actor.id, actorName(actor), now, id)
        .run();
      return jsonResponse({ updated: true, id });
    }

    return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível salvar o acompanhamento por liderado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O ACOMPANHAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR O ACOMPANHAMENTO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const url = new URL(request.url);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const memberName = safeText(url.searchParams.get("memberName"), 160);
  const cycleStart = safeText(url.searchParams.get("cycleStart"), 10);
  if (!companyId || !memberName || !DATE_PATTERN.test(cycleStart)) return jsonResponse({ error: "CICLO INVÁLIDO." }, 400);
  try {
    await (await getD1())
      .prepare("DELETE FROM hr_store_followups WHERE company_id=?1 AND member_name=?2 AND cycle_start=?3")
      .bind(companyId, memberName, cycleStart)
      .run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o ciclo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O CICLO." }, 500);
  }
}
