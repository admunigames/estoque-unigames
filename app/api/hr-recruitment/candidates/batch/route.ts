import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import {
  DATE_PATTERN,
  actorName,
  canManageRecruitment,
  identity,
  isStatusValid,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../shared";

// CADASTRO EM LOTE de candidatos (25/11/2026): a lista colada (NOME - CONTATO,
// ou colunas da planilha) vira vários candidatos de uma vez, todos no mesmo
// status inicial, cada um com o seu histórico de status — o mesmo que o NOVO
// CANDIDATO faz um a um. Tudo num batch só: ou entram todos, ou nenhum.

const BATCH_LIMIT = 300;
// Começa no início do pipeline: CONTRATADO e INTEGRAÇÃO exigem admissão (um a um).
const BATCH_STATUSES = new Set(["selecionado_entrevista", "em_teste", "em_treinamento", "stand_by"]);

const dateOrEmpty = (value: unknown) => {
  const text = safeText(value, 10);
  return DATE_PATTERN.test(text) ? text : "";
};
const timeOrEmpty = (value: unknown) => {
  const text = safeText(value, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : "";
};

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CANDIDATOS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const status = safeText(body.status, 30) || "selecionado_entrevista";
    if (!isStatusValid(status) || !BATCH_STATUSES.has(status)) {
      return jsonResponse({ error: "NO CADASTRO EM LOTE O STATUS INICIAL É SELECIONADO ENTREVISTA, EM TESTE, EM TREINAMENTO OU STAND BY." }, 400);
    }
    const raw = Array.isArray(body.items) ? body.items : [];
    if (!raw.length) return jsonResponse({ error: "COLE PELO MENOS UM CANDIDATO." }, 400);
    if (raw.length > BATCH_LIMIT) return jsonResponse({ error: `NO MÁXIMO ${BATCH_LIMIT} CANDIDATOS POR VEZ.` }, 400);
    const items = raw
      .map((item) => (item && typeof item === "object" ? (item as JsonMap) : {}))
      .map((item) => ({
        // Nomes do RH sempre em CAIXA ALTA (vira o nome do funcionário na admissão).
        fullName: safeText(item.fullName, 160).toLocaleUpperCase("pt-BR"),
        phone: safeText(item.phone, 40),
        desiredRole: safeText(item.desiredRole, 120),
        interviewDate: dateOrEmpty(item.interviewDate),
        interviewTime: timeOrEmpty(item.interviewTime),
      }));
    const missing = items.findIndex((item) => !item.fullName);
    if (missing >= 0) return jsonResponse({ error: `INFORME O NOME DO CANDIDATO DA LINHA ${missing + 1}.` }, 400);

    const database = await getD1();
    const statements = [];
    for (const item of items) {
      const id = crypto.randomUUID();
      statements.push(
        database
          .prepare(
            `INSERT INTO hr_recruitment_candidates
              (id, full_name, desired_role, status, interview_date, interview_time, script_sent,
               interview_result, interview_result_reason, created_by, created_by_name, created_at,
               updated_by, updated_by_name, updated_at, phone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, '', '', ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP, ?9)`,
          )
          .bind(id, item.fullName, item.desiredRole, status, item.interviewDate, item.interviewTime, actor.id, actorName(actor), item.phone),
        database
          .prepare(
            `INSERT INTO hr_recruitment_status_history
              (id, candidate_id, from_status, to_status, note, changed_by, changed_by_name, changed_at)
             VALUES (?1, ?2, '', ?3, 'CADASTRO EM LOTE', ?4, ?5, CURRENT_TIMESTAMP)`,
          )
          .bind(crypto.randomUUID(), id, status, actor.id, actorName(actor)),
      );
    }
    await database.batch(statements);
    return jsonResponse({ created: items.length }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar os candidatos em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR OS CANDIDATOS." }, 500);
  }
}
