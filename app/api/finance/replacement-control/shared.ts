import type { getD1 } from "../../../../db";
import { safeText, type JsonMap } from "../shared";
import { loadExpense, planExpenseDeletion } from "../expenses/shared";
import { INFLOW_KINDS, OUTFLOW_KINDS } from "../../../lib/replacement-balance";

// Controle de Reposição — validação única de um lançamento, usada pelo POST
// individual (route.ts) e pelo CADASTRAR EM LOTE (batch/route.ts).
// 02/11/2026: o lançamento não tem unidade específica nem setor (lançamentos
// antigos mantêm os que têm); produto é opcional e o MOTIVO é obrigatório.
// 23/11/2026: o lançamento é só ENTRADA ou SAÍDA (os tipos antigos continuam
// gravados e somam no grupo — app/lib/replacement-balance.ts); setor volta a
// ser escolhido; categoria própria e categoria financeira opcionais. Mês
// FINALIZADO trava data/valor/tipo/responsável (lançar, editar, excluir).

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const SECTORS = new Set(["assistencia", "logistica", "outros"]);
// Tipos aceitos em lançamento novo/editado; KIND_GROUPS = filtro ENTRADA/SAÍDA com os antigos.
export const KINDS = new Set(["entrada", "saida", "outros_entrada", "outros_saida"]);
export const KIND_GROUPS: Record<string, string[]> = { entrada: INFLOW_KINDS, saida: OUTFLOW_KINDS, outros: ["outros_entrada", "outros_saida"] };

export type ReplacementEntry = {
  entryDate: string;
  companyId: string;
  companyName: string;
  product: string;
  reason: string;
  sector: string;
  responsibleName: string;
  kind: string;
  notes: string;
  amountCents: number;
  category: string;
  financeItemId: string;
};

export function parseReplacementEntry(body: JsonMap): { error: string } | ReplacementEntry {
  const entryDate = safeText(body.entryDate, 10);
  if (!DATE_PATTERN.test(entryDate)) return { error: "INFORME A DATA." };
  const companyId = safeText(body.companyId, 80);
  const product = safeText(body.product, 200);
  const reason = safeText(body.reason, 500);
  if (reason.length < 2) return { error: "INFORME O MOTIVO." };
  const sector = safeText(body.sector, 20);
  if (sector && !SECTORS.has(sector)) return { error: "SETOR INVÁLIDO." };
  const kind = safeText(body.kind, 20);
  if (!KINDS.has(kind)) return { error: "SELECIONE SE É ENTRADA, SAÍDA OU OUTROS." };
  const amountCents = Number(body.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." };
  // A reposição não é ligada a conta cadastrada — só ao RESPONSÁVEL (23/10/2026).
  if (!safeText(body.responsibleName, 160)) return { error: "INFORME O RESPONSÁVEL." };
  return {
    entryDate,
    companyId,
    companyName: companyId ? safeText(body.companyName, 160) : "",
    product,
    reason,
    sector,
    responsibleName: safeText(body.responsibleName, 160),
    kind,
    notes: safeText(body.notes, 2000),
    amountCents,
    category: safeText(body.category, 120),
    financeItemId: safeText(body.financeItemId, 80),
  };
}

export function insertReplacementStatement(entry: ReplacementEntry, actor: { id: string; name: string }): [string, unknown[]] {
  return [
    `INSERT INTO finance_replacement_entries
      (id, entry_date, company_id, company_name, product, reason, sector, responsible_name,
       amount_cents, kind, notes, created_by, created_by_name, created_at,
       updated_by, updated_by_name, updated_at, category, finance_item_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,CURRENT_TIMESTAMP,?12,?13,CURRENT_TIMESTAMP,?14,?15)`,
    [
      crypto.randomUUID(), entry.entryDate, entry.companyId, entry.companyName, entry.product, entry.reason,
      entry.sector, entry.responsibleName, entry.amountCents, entry.kind, entry.notes, actor.id, actor.name,
      entry.category, entry.financeItemId,
    ],
  ];
}

/**
 * EXCLUIR um lançamento: sozinho, ou com a despesa vinculada (withExpense —
 * "ADICIONAR COMO DESPESA") pela mesma regra do EXCLUIR de Despesas; a
 * despesa com pagamento confirmado faz o lançamento ser pulado com o motivo.
 */
export async function planReplacementDelete(
  database: Awaited<ReturnType<typeof getD1>>,
  row: { id: string; expenseId: string },
  withExpense: boolean,
  actor: { id: string; name: string },
): Promise<{ statements: [string, unknown[]][] } | { skip: string }> {
  const statements: [string, unknown[]][] = [];
  if (row.expenseId && withExpense) {
    const expense = await loadExpense(database, row.expenseId);
    if (expense) {
      const plan = await planExpenseDeletion(database, expense, actor);
      if ("skip" in plan) return { skip: `A DESPESA VINCULADA ${plan.skip}` };
      statements.push(...plan.statements);
    }
  }
  statements.push(["DELETE FROM finance_replacement_entries WHERE id=?1", [row.id]]);
  return { statements };
}

/** Meses FINALIZADOS (YYYY-MM) — lançamento com data neles não é criado, editado nem excluído. */
export async function closedReplacementMonths(database: Awaited<ReturnType<typeof getD1>>): Promise<Set<string>> {
  const result = await database
    .prepare("SELECT DISTINCT month FROM finance_replacement_balances WHERE kind='closing'")
    .all<{ month: string }>();
  return new Set((result.results ?? []).map((row) => row.month));
}

export function closedMonthError(month: string) {
  return `O MÊS ${month.slice(5, 7)}/${month.slice(0, 4)} ESTÁ FINALIZADO. REABRA O MÊS PARA ALTERAR.`;
}
