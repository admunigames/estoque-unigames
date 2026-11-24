import type { getD1 } from "../../db";

// RH > Plano Odontológico AUTOMÁTICO (24/11/2026, pedido do usuário):
//  - ADMISSÃO (cadastro novo ativo ou CONTRATADO no Recrutamento) → pendência
//    FALTANDO INCLUIR, motivo INCLUSÃO, unidade/CNPJ da loja cadastrada e
//    observação "ADMITIDO EM dd/mm/aaaa · LOJA".
//  - DESLIGAMENTO (botão DESLIGAMENTO ou inativar pelo EDITAR) → quem está
//    incluso/faltando incluir/inclusão solicitada passa a FALTANDO EXCLUIR,
//    motivo EXCLUSÃO e "DESLIGADO EM dd/mm/aaaa · MOTIVO" na frente das
//    observações; sem registro nenhum, cria a pendência de exclusão.
//  - Nº DO PROCESSO fica em branco: é o protocolo da operadora, o RH digita.
// Só daqui pra frente (sem retroativo — decisão do usuário). As instruções são
// idempotentes (NOT EXISTS / filtro de status) para entrar no mesmo batch da
// admissão/desligamento sem duplicar.

type Database = Awaited<ReturnType<typeof getD1>>;
type Actor = { id: string; name: string };
type Company = { id: string; name: string; cnpj?: string };

const upper = (value: string) => value.toLocaleUpperCase("pt-BR");
const dateBr = (date: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split("-").reverse().join("/") : "");

export function formatCnpj(value: string) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length !== 14) return String(value || "").trim();
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

async function companyOf(database: Database, companyId: string): Promise<{ name: string; cnpj: string }> {
  if (!companyId) return { name: "", cnpj: "" };
  if (companyId === "assistencia") return { name: "ASSISTÊNCIA", cnpj: "" };
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  let list: Company[] = [];
  try {
    list = JSON.parse(row?.value || "[]");
  } catch {
    list = [];
  }
  const company = (Array.isArray(list) ? list : []).find((item) => item && item.id === companyId);
  return { name: upper(company?.name || ""), cnpj: formatCnpj(company?.cnpj || "") };
}

function insertPending(
  database: Database,
  values: { employeeId: string; employeeName: string; unitName: string; cnpj: string; status: string; reason: string; notes: string },
  actor: Actor,
) {
  // INSERT ... SELECT ... WHERE NOT EXISTS: um registro por funcionário.
  return database
    .prepare(
      `INSERT INTO hr_dental_plan
        (id, employee_id, employee_name, unit_name, cnpj, status, reason, process_number, notes,
         created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP
       WHERE NOT EXISTS (SELECT 1 FROM hr_dental_plan WHERE employee_id=?2)`,
    )
    .bind(
      crypto.randomUUID(),
      values.employeeId,
      upper(values.employeeName),
      values.unitName,
      values.cnpj,
      values.status,
      values.reason,
      upper(values.notes).slice(0, 2000),
      actor.id,
      actor.name,
    );
}

/** Admissão → FALTANDO INCLUIR (só se o funcionário ainda não tem registro). */
export async function dentalPlanAdmissionStatements(
  database: Database,
  employee: { id: string; fullName: string; admissionDate: string; companyId: string },
  actor: Actor,
) {
  const company = await companyOf(database, employee.companyId);
  const admitted = dateBr(employee.admissionDate);
  const notes = [admitted ? `ADMITIDO EM ${admitted}` : "ADMITIDO", company.name].filter(Boolean).join(" · ");
  return [
    insertPending(database, {
      employeeId: employee.id,
      employeeName: employee.fullName,
      unitName: company.name,
      cnpj: company.cnpj,
      status: "faltando_incluir",
      reason: "inclusao",
      notes,
    }, actor),
  ];
}

/** Desligamento → FALTANDO EXCLUIR (atualiza o registro ou cria a pendência). */
export async function dentalPlanTerminationStatements(
  database: Database,
  employee: { id: string; fullName: string; companyId: string; terminationDate: string; reasonLabel: string },
  actor: Actor,
) {
  const company = await companyOf(database, employee.companyId);
  const left = dateBr(employee.terminationDate);
  const note = upper([left ? `DESLIGADO EM ${left}` : "DESLIGADO", employee.reasonLabel].filter(Boolean).join(" · "));
  return [
    database
      .prepare(
        `UPDATE hr_dental_plan SET status='faltando_excluir', reason='exclusao',
           notes=CASE WHEN notes='' THEN ?2 ELSE ?2 || ' · ' || notes END,
           updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
         WHERE employee_id=?1 AND status IN ('incluso', 'faltando_incluir', 'inclusao_solicitada')`,
      )
      .bind(employee.id, note, actor.id, actor.name),
    insertPending(database, {
      employeeId: employee.id,
      employeeName: employee.fullName,
      unitName: company.name,
      cnpj: company.cnpj,
      status: "faltando_excluir",
      reason: "exclusao",
      notes: note,
    }, actor),
  ];
}
