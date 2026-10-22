import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { computeEmployeeCost, sumEmployeeCosts } from "../../../lib/hr-cost-report";
import { canManagePayroll, identity, jsonResponse, MONTH_PATTERN, safeText, type Identity } from "../shared";
import { loadPayrollRows } from "../entries/rows";

// CUSTO TOTAL POR FUNCIONÁRIO (botão na Folha de Pagamento) — só para quem tem
// o RH Financeiro E o Financeiro. Uma linha por funcionário da Folha do mês
// (mesmas linhas da tela) + a linha TOTAL. Fórmulas em app/lib/hr-cost-report.ts.
//   salário base = o da folha lançada (sem folha, o do cadastro);
//   comissão     = comissão bruta do Comissionamento (sem os descontos);
//   HE           = horas extras em R$ da folha;
//   DSR          = valor MANUAL do mês (hr_employee_month_values).

function canSeeCostReport(actor: Identity) {
  return canManagePayroll(actor) && (actor.role === "admin" || actor.permissions.some((permission) => permission.startsWith("finance:")));
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canSeeCostReport(identity(request))) {
    return jsonResponse({ error: "O CUSTO TOTAL POR FUNCIONÁRIO É SÓ PARA QUEM TEM RH FINANCEIRO E FINANCEIRO." }, 403);
  }
  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  try {
    const database = await getD1();
    const payroll = await loadPayrollRows(database, month, companyId);
    const rows = payroll.map((row) => ({
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      companyId: row.companyId,
      companyName: row.companyName,
      saved: row.saved,
      ...computeEmployeeCost({
        baseSalaryCents: row.baseSalaryCents,
        commissionCents: row.commissionGrossCents,
        overtimeCents: row.overtimeCents,
        dsrCents: row.dsrCents,
      }),
    }));
    return jsonResponse({ month, companyId, rows, total: sumEmployeeCosts(rows) });
  } catch (error) {
    console.error("Não foi possível montar o custo total por funcionário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O CUSTO TOTAL POR FUNCIONÁRIO." }, 500);
  }
}
