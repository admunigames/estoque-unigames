import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { actingStoresForMonth } from "../../../lib/acting-store";
import {
  buildAccountingReport,
  commissionCarryChain,
  computeOvertime,
  nextMonth,
  type AccountingPerson,
  type CommissionCarry,
} from "../../../lib/hr-accounting-report";
import { loadCompanyList } from "../../finance/shared";
import { COMMISSION_SYNC_FROM, identity as commercialIdentity, syncHrCommissions } from "../../commercial/shared";
import {
  canManagePayroll,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  overtimeInputOf,
  safeText,
  type OvertimePayoutRow,
} from "../shared";

// Relatório COMISSIONAMENTO / HORAS / PREMIAÇÃO para a contabilidade (RH >
// Relatório Contabilidade; atalho no grupo RH Financeiro do menu). Um relatório
// do mês com todos os funcionários, agrupado por EMPRESA (CNPJ do cadastro de
// Lojas, pela loja atuante do mês):
//   COMISSÃO BRUTA = comissão (Comercial ou digitada) + bônus + ajustes;
//   DESCONTOS (com descrição) — sempre na comissão; a sobra vai para o mês
//   seguinte (app/lib/hr-accounting-report.ts); PREMIAÇÃO = do Comercial +
//   premiações do RH; HE = HORAS EXTRAS A PAGAR do Controle de Horas.
// Antes de montar, regrava a comissão/premiação do Comercial dos meses desde
// COMMISSION_SYNC_FROM (o mesmo syncHrCommissions de cada lançamento do
// Comercial): garante a premiação separada nos meses anteriores à migration.

type CommissionHistoryRow = {
  id: string;
  employeeId: string;
  month: string;
  commissionCents: number;
  commercialPremiumCents: number;
  bonusesCents: number;
  premiumsCents: number;
  discountsCents: number;
  adjustmentsCents: number;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);

  try {
    const database = await getD1();
    for (let synced = COMMISSION_SYNC_FROM; synced <= month; synced = nextMonth(synced)) {
      await syncHrCommissions(database, synced, commercialIdentity(request));
    }
    const [employeesResult, history, discountItems, payouts, actingStores, companies] = await Promise.all([
      database.prepare("SELECT id, full_name AS fullName FROM hr_employees").all<{ id: string; fullName: string }>(),
      database
        .prepare(
          `SELECT id, employee_id AS employeeId, month, commission_cents AS commissionCents,
                  commercial_premium_cents AS commercialPremiumCents, bonuses_cents AS bonusesCents,
                  premiums_cents AS premiumsCents, discounts_cents AS discountsCents, adjustments_cents AS adjustmentsCents
           FROM hr_commissions WHERE month <= ?1`,
        )
        .bind(month)
        .all<CommissionHistoryRow>(),
      database
        .prepare(
          `SELECT c.employee_id AS employeeId, i.label, i.amount_cents AS amountCents,
                  i.installment_number AS installmentNumber, i.installment_total AS installmentTotal
           FROM hr_commission_items i JOIN hr_commissions c ON c.id = i.commission_id
           WHERE c.month = ?1 AND i.kind = 'desconto' ORDER BY i.created_at`,
        )
        .bind(month)
        .all<{ employeeId: string; label: string; amountCents: number; installmentNumber: number; installmentTotal: number }>(),
      database
        .prepare(
          `SELECT employee_id AS employeeId, he50_minutes AS he50Minutes, he100_minutes AS he100Minutes, night_minutes AS nightMinutes,
                  he50_rate_cents AS he50RateCents, he100_rate_cents AS he100RateCents, night_rate_cents AS nightRateCents
           FROM hr_time_tracking_payouts WHERE year_month = ?1`,
        )
        .bind(month)
        .all<OvertimePayoutRow>(),
      actingStoresForMonth(database, month),
      loadCompanyList(database) as Promise<Array<{ id: string; name: string; cnpj?: string }>>,
    ]);

    const historyByEmployee = new Map<string, CommissionHistoryRow[]>();
    for (const row of history.results ?? []) {
      const list = historyByEmployee.get(row.employeeId) ?? [];
      list.push(row);
      historyByEmployee.set(row.employeeId, list);
    }
    const labelsByEmployee = new Map<string, string[]>();
    for (const item of discountItems.results ?? []) {
      const parcela = Number(item.installmentTotal) >= 2 ? ` (${item.installmentNumber}/${item.installmentTotal})` : "";
      const list = labelsByEmployee.get(item.employeeId) ?? [];
      list.push(`${item.label}${parcela}`);
      labelsByEmployee.set(item.employeeId, list);
    }
    const payoutByEmployee = new Map((payouts.results ?? []).map((row) => [row.employeeId, row]));
    const companyOf = (companyId: string) => companies.find((company) => company.id === companyId);

    const people: AccountingPerson[] = (employeesResult.results ?? []).map((employee) => {
      const rows = historyByEmployee.get(employee.id) ?? [];
      const chain = commissionCarryChain(
        rows.map((row) => ({
          month: row.month,
          commissionCents: Number(row.commissionCents || 0) + Number(row.bonusesCents || 0) + Number(row.adjustmentsCents || 0),
          discountCents: Number(row.discountsCents || 0),
        })),
        month,
      );
      const empty: CommissionCarry = { month, commissionCents: 0, discountCents: 0, carryInCents: 0, appliedCents: 0, netCommissionCents: 0, carryOutCents: 0 };
      const carry = chain.get(month) ?? empty;
      const current = rows.find((row) => row.month === month);
      const store = actingStores.get(employee.id);
      const company = store ? companyOf(store.companyId) : undefined;
      const labels = [...(labelsByEmployee.get(employee.id) ?? [])];
      if (carry.carryInCents) labels.unshift("SOBRA DE DESCONTO DO MÊS ANTERIOR");
      const payout = payoutByEmployee.get(employee.id);
      return {
        employeeId: employee.id,
        employeeName: employee.fullName,
        companyId: store?.companyId ?? "",
        companyName: company?.name ?? store?.companyName ?? "",
        cnpj: String(company?.cnpj || "").replace(/\D+/g, ""),
        carry,
        discountLabels: labels,
        premiumCents: Number(current?.commercialPremiumCents || 0) + Number(current?.premiumsCents || 0),
        overtime: computeOvertime(payout ? overtimeInputOf(payout) : {}),
      };
    });
    return jsonResponse({ month, ...buildAccountingReport(people) });
  } catch (error) {
    console.error("Não foi possível montar o relatório da contabilidade.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O RELATÓRIO DA CONTABILIDADE." }, 500);
  }
}
