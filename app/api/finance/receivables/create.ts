import type { getD1 } from "../../../../db";
import { DATE_PATTERN } from "../../../lib/payables-recurrence";
import { expectedDateFromCompetence } from "../../../lib/receivables-status";
import { loadCompanyList, MONTH_PATTERN, safeText, type JsonMap } from "../shared";
import { parseReceived, resolveReceivableOperator } from "./shared";

// Valida o corpo de UM recebível e monta o INSERT sem executar — usada pelo
// POST e pelo CADASTRAR EM LOTE (receivables/batch).
export async function planReceivableCreate(
  database: Awaited<ReturnType<typeof getD1>>,
  actor: { id: string; displayName: string },
  scopeActor: { companyId: string },
  allStores: boolean,
  body: JsonMap,
): Promise<{ reply: { payload: JsonMap; status: number } } | { id: string; statements: [string, unknown[]][] }> {
  const reply = (payload: JsonMap, status = 200) => ({ reply: { payload, status } });
  const requestedCompanyId = safeText(body.companyId, 80);
  const companyId = allStores ? requestedCompanyId : scopeActor.companyId;
  if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
    return reply({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  if (!companyId) return reply({ error: "SELECIONE A UNIDADE." }, 400);

  const competenceMonth = safeText(body.competenceMonth, 7);
  const notes = safeText(body.notes, 500);
  // Cadastro simplificado (item 4): o cliente manda só `amountCents`.
  // `expectedAmountCents` continua aceito por compatibilidade.
  const expectedAmountCents = Math.round(Number(body.amountCents ?? body.expectedAmountCents));

  if (!MONTH_PATTERN.test(competenceMonth)) {
    return reply({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
  }
  // Data prevista não é mais pedida no cadastro — quando o cliente não
  // manda uma data válida, cai no último dia da competência.
  const requestedExpectedDate = safeText(body.expectedDate, 10);
  const expectedDate = DATE_PATTERN.test(requestedExpectedDate)
    ? requestedExpectedDate
    : expectedDateFromCompetence(competenceMonth);
  if (!Number.isFinite(expectedAmountCents) || expectedAmountCents <= 0) {
    return reply({ error: "INFORME UM VALOR MAIOR QUE ZERO." }, 400);
  }

  // Recebimento já pode vir preenchido na criação (lançamento retroativo).
  const receivedParsed = parseReceived(body);
  if (receivedParsed.error) return reply({ error: receivedParsed.error }, 400);

  const companies = await loadCompanyList(database);
  const company = companies.find((item) => item.id === companyId);
  if (!company) return reply({ error: "LOJA NÃO ENCONTRADA." }, 400);

  const operator = await resolveReceivableOperator(database, body, companyId);
  if (operator.error) return reply({ error: operator.error }, 400);
  const { operatorText } = operator;

  const idempotencyKey =
    safeText(body.idempotencyKey, 120) ||
    `receivable:${companyId}:${competenceMonth}:${expectedDate}:${operatorText}:${expectedAmountCents}:${crypto.randomUUID()}`;
  const existing = await database
    .prepare("SELECT id FROM accounts_receivable WHERE idempotency_key=?1")
    .bind(idempotencyKey)
    .first<{ id: string }>();
  if (existing) return reply({ created: true, alreadyProcessed: true, id: existing.id });

  const id = crypto.randomUUID();
  const actorName = actor.displayName || "Administrador";
  const statements: [string, unknown[]][] = [[
      `INSERT INTO accounts_receivable
        (id, company_id, company_name, operator_text, acquirer_id, competence_month, expected_date,
         expected_amount_cents, received_amount_cents, received_date, notes, canceled, idempotency_key,
         created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?14, CURRENT_TIMESTAMP, ?13, ?14, CURRENT_TIMESTAMP)`,
    [
      id,
      companyId,
      company.name,
      operatorText,
      operator.acquirerId,
      competenceMonth,
      expectedDate,
      expectedAmountCents,
      receivedParsed.receivedAmountCents,
      receivedParsed.receivedDate,
      notes,
      idempotencyKey,
      actor.id,
      actorName,
    ],
  ]];

  return { id, statements };
}
