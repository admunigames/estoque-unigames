import { safeText, type JsonMap } from "../shared";

// Controle de Reposição — validação única de um lançamento, usada pelo POST
// individual (route.ts) e pelo CADASTRAR EM LOTE (batch/route.ts).

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const SECTORS = new Set(["assistencia", "logistica", "outros"]);
export const KINDS = new Set(["entrada", "saida", "reposicao", "ressarcimento", "prejuizo", "recuperacao"]);

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
};

export function parseReplacementEntry(body: JsonMap): { error: string } | ReplacementEntry {
  const entryDate = safeText(body.entryDate, 10);
  if (!DATE_PATTERN.test(entryDate)) return { error: "INFORME A DATA." };
  const companyId = safeText(body.companyId, 80);
  if (!companyId) return { error: "SELECIONE A UNIDADE." };
  const product = safeText(body.product, 200);
  if (product.length < 2) return { error: "INFORME O PRODUTO." };
  const sector = safeText(body.sector, 20);
  if (!SECTORS.has(sector)) return { error: "SELECIONE O SETOR RESPONSÁVEL." };
  const kind = safeText(body.kind, 20);
  if (!KINDS.has(kind)) return { error: "SELECIONE O TIPO DO LANÇAMENTO." };
  const amountCents = Number(body.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." };
  return {
    entryDate,
    companyId,
    companyName: safeText(body.companyName, 160),
    product,
    reason: safeText(body.reason, 500),
    sector,
    responsibleName: safeText(body.responsibleName, 160),
    kind,
    notes: safeText(body.notes, 2000),
    amountCents,
  };
}

export function insertReplacementStatement(entry: ReplacementEntry, actor: { id: string; name: string }): [string, unknown[]] {
  return [
    `INSERT INTO finance_replacement_entries
      (id, entry_date, company_id, company_name, product, reason, sector, responsible_name,
       amount_cents, kind, notes, created_by, created_by_name, created_at,
       updated_by, updated_by_name, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,CURRENT_TIMESTAMP,?12,?13,CURRENT_TIMESTAMP)`,
    [
      crypto.randomUUID(), entry.entryDate, entry.companyId, entry.companyName, entry.product, entry.reason,
      entry.sector, entry.responsibleName, entry.amountCents, entry.kind, entry.notes, actor.id, actor.name,
    ],
  ];
}
