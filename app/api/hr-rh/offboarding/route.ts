import { getD1 } from "../../../../db";
import { DATE_RE, checklistPendingCount, normalizeChecklist, terminationError } from "../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../lib/notion";
import { actorName, identity, jsonResponse, rhCan, safeText, sameOrigin, type JsonMap } from "../shared";

// RH > Painel do RH > Desligamentos — motivo e checklist demissional de cada
// desligamento (hr_terminations). O desligamento nasce em RH > Funcionários
// (ao marcar INATIVO) ou na Rescisão da DRE; aqui o RH acompanha e conclui o
// checklist (alerta até não sobrar item pendente). Valores da rescisão ficam
// com o RH Financeiro (DRE Funcionário).

type Row = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  terminationDate: string;
  reason: string;
  reasonOther: string;
  checklistJson: string;
  severancePaidDate: string;
  updatedByName: string;
  updatedAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!rhCan(identity(request), "rh_desligamento:view", "rh_desligamento:manage")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER OS DESLIGAMENTOS." }, 403);
  }
  try {
    const result = await (await getD1())
      .prepare(
        `SELECT id, employee_id AS employeeId, employee_name AS employeeName, company_id AS companyId,
                company_name AS companyName, termination_date AS terminationDate, reason,
                reason_other AS reasonOther, checklist_json AS checklistJson,
                severance_paid_date AS severancePaidDate,
                updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM hr_terminations ORDER BY termination_date DESC, employee_name ASC`,
      )
      .all<Row>();
    const terminations = (result.results ?? []).map((row) => ({
      ...row,
      checklist: normalizeChecklist(JSON.parse(row.checklistJson || "{}")),
      pending: checklistPendingCount(row.checklistJson),
    }));
    return jsonResponse({ terminations });
  } catch (error) {
    console.error("Não foi possível carregar os desligamentos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS DESLIGAMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!rhCan(actor, "rh_desligamento:manage")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O DESLIGAMENTO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const terminationDate = safeText(body.terminationDate, 10);
    const reason = safeText(body.reason, 30);
    const reasonOther = safeText(body.reasonOther, 300);
    const paid = safeText(body.severancePaidDate, 10);
    const error = terminationError(terminationDate, reason, reasonOther) ||
      (paid && !DATE_RE.test(paid) ? "INFORME UMA DATA DE PAGAMENTO DA RESCISÃO VÁLIDA." : "");
    if (error) return jsonResponse({ error }, 400);
    const checklist = normalizeChecklist(body.checklist);
    for (const entry of Object.values(checklist)) entry.note = entry.note.toLocaleUpperCase("pt-BR");
    const database = await getD1();
    const existing = await database.prepare("SELECT id FROM hr_terminations WHERE id=?1").bind(id).first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "DESLIGAMENTO NÃO ENCONTRADO." }, 404);
    await database
      .prepare(
        `UPDATE hr_terminations SET termination_date=?1, reason=?2, reason_other=?3, checklist_json=?4,
           updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP, severance_paid_date=?8 WHERE id=?7`,
      )
      .bind(terminationDate, reason, reason === "outro" ? reasonOther : "", JSON.stringify(checklist), actor.id, actorName(actor), id, paid)
      .run();
    return jsonResponse({ updated: true, id, pending: checklistPendingCount(JSON.stringify(checklist)) });
  } catch (error) {
    console.error("Não foi possível salvar o desligamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O DESLIGAMENTO." }, 500);
  }
}
