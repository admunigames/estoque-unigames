import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  actorName,
  canManageRecruitment,
  canViewRecruitment,
  centsValue,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type JsonMap,
} from "../shared";

// Lançamentos de pagamento de teste/treinamento (Etapa 2) — múltiplos
// registros por candidato, sempre criados (nunca editados in-place).

type PaymentRow = {
  id: string;
  candidateId: string;
  amountCents: number;
  paidDate: string;
  note: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RECRUTAMENTO E SELEÇÃO." }, 403);
  }

  const candidateId = safeText(new URL(request.url).searchParams.get("candidateId"), 80);
  if (!uuidIsValid(candidateId)) return jsonResponse({ error: "CANDIDATO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, candidate_id AS candidateId, amount_cents AS amountCents, paid_date AS paidDate,
                note, created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
         FROM hr_recruitment_test_payments WHERE candidate_id=?1 ORDER BY paid_date ASC, created_at ASC`,
      )
      .bind(candidateId)
      .all<PaymentRow>();
    return jsonResponse({ payments: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os pagamentos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PAGAMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR PAGAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const candidateId = safeText(body.candidateId, 80);
    const amountCents = centsValue(body.amountCents ?? 0);
    const paidDate = safeText(body.paidDate, 10);
    const note = safeText(body.note, 500);

    if (!uuidIsValid(candidateId)) return jsonResponse({ error: "CANDIDATO INVÁLIDO." }, 400);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR PAGO VÁLIDO." }, 400);
    }
    if (!paidDate || !DATE_PATTERN.test(paidDate)) {
      return jsonResponse({ error: "INFORME UMA DATA DE PAGAMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
    }

    const database = await getD1();
    const candidate = await database
      .prepare("SELECT id FROM hr_recruitment_candidates WHERE id=?1")
      .bind(candidateId)
      .first<{ id: string }>();
    if (!candidate) return jsonResponse({ error: "CANDIDATO NÃO ENCONTRADO." }, 404);

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_recruitment_test_payments
          (id, candidate_id, amount_cents, paid_date, note, created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)`,
      )
      .bind(id, candidateId, amountCents, paidDate, note, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível lançar o pagamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LANÇAR O PAGAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR PAGAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "PAGAMENTO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_recruitment_test_payments WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "PAGAMENTO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_recruitment_test_payments WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o pagamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O PAGAMENTO." }, 500);
  }
}
