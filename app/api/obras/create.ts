import { loadCompanyList } from "../finance/shared";
import { DATE_PATTERN, OBRA_KINDS, OBRA_STATUSES, actorName, centsValue, isOneOf, safeText, type Database, type Identity } from "./shared";

type JsonMap = Record<string, unknown>;

export type ObraInput = {
  companyId: string;
  companyName: string;
  title: string;
  description: string;
  kind: string;
  responsible: string;
  supplierId: string;
  budgetCents: number;
  startDate: string;
  expectedEndDate: string;
  endDate: string;
  status: string;
  notes: string;
};

/** Valida UMA obra (cadastro ou edição) — usada pelo POST e pelo CADASTRAR EM LOTE (obras/batch). */
export async function validateObra(database: Database, body: JsonMap): Promise<{ error: string } | { input: ObraInput }> {
  const title = safeText(body.title, 160);
  const description = safeText(body.description, 2000);
  const kind = safeText(body.kind, 20) || "reforma";
  const responsible = safeText(body.responsible, 160);
  const supplierId = safeText(body.supplierId, 80);
  const companyId = safeText(body.companyId, 80);
  const status = safeText(body.status, 20) || "planejada";
  const notes = safeText(body.notes, 2000);
  const budgetCents = body.budgetCents === undefined || body.budgetCents === null || body.budgetCents === ""
    ? 0
    : centsValue(body.budgetCents);
  const startDate = safeText(body.startDate, 10);
  const expectedEndDate = safeText(body.expectedEndDate, 10);
  const endDate = safeText(body.endDate, 10);

  if (!title) return { error: "INFORME O TÍTULO DA OBRA." };
  if (!isOneOf(OBRA_KINDS, kind)) return { error: "TIPO DE OBRA INVÁLIDO." };
  if (!isOneOf(OBRA_STATUSES, status)) return { error: "STATUS DE OBRA INVÁLIDO." };
  if (!Number.isFinite(budgetCents) || budgetCents < 0) return { error: "INFORME UM VALOR ORÇADO VÁLIDO." };
  for (const [label, value] of [
    ["INÍCIO", startDate],
    ["PREVISÃO DE CONCLUSÃO", expectedEndDate],
    ["CONCLUSÃO", endDate],
  ] as Array<[string, string]>) {
    if (value && !DATE_PATTERN.test(value)) return { error: `INFORME UMA DATA DE ${label} VÁLIDA (AAAA-MM-DD).` };
  }

  let companyName = "";
  if (companyId) {
    const companies = await loadCompanyList(database);
    const company = companies.find((item) => item.id === companyId);
    if (!company) return { error: "LOJA NÃO ENCONTRADA." };
    companyName = company.name;
  }
  return {
    input: {
      companyId, companyName, title, description, kind, responsible, supplierId, budgetCents, startDate,
      expectedEndDate, endDate, status, notes,
    },
  };
}

export function insertObraSql(id: string, input: ObraInput, actor: Identity): [string, unknown[]] {
  return [
    `INSERT INTO obras
      (id, company_id, company_name, title, description, kind, responsible, supplier_id,
       budget_cents, start_date, expected_end_date, end_date, status, notes, created_by,
       created_by_name, created_at, updated_by, updated_by_name, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
             CURRENT_TIMESTAMP, ?15, ?16, CURRENT_TIMESTAMP)`,
    [
      id, input.companyId, input.companyName, input.title, input.description, input.kind, input.responsible,
      input.supplierId, input.budgetCents, input.startDate, input.expectedEndDate, input.endDate, input.status,
      input.notes, actor.id, actorName(actor),
    ],
  ];
}
