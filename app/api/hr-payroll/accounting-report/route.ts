import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { actingStoresForMonth } from "../../../lib/acting-store";
import {
  buildAccountingReport,
  commissionCarryChain,
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
  loadMonthValues,
  MONTH_PATTERN,
  safeText,
} from "../shared";

// Relatório COMISSIONAMENTO / HORAS / PREMIAÇÃO para a contabilidade (RH >
// Relatório Contabilidade; atalho no grupo RH Financeiro do menu). Desde
// 23/10/2026 só três colunas, agrupadas por EMPRESA (CNPJ do cadastro de
// Lojas, pela loja atuante do mês):
//   COMISSIONAMENTO = comissão (Comercial ou digitada) + bônus + ajustes,
//     com o desconto aplicado — se o desconto passar da comissão, a sobra vai
//     para o mês seguinte (app/lib/hr-accounting-report.ts);
//   HORAS EXTRAS = valor ÚNICO em R$ digitado à mão no próprio relatório
//     (hr_employee_month_values, kind 'he');
//   PREMIAÇÃO = do Comercial + premiações lançadas no RH.
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
    const [employeesResult, history, overtimeByEmployee, actingStores, companies] = await Promise.all([
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
      loadMonthValues(database, month, "he"),
      actingStoresForMonth(database, month),
      loadCompanyList(database) as Promise<Array<{ id: string; name: string; cnpj?: string }>>,
    ]);

    const historyByEmployee = new Map<string, CommissionHistoryRow[]>();
    for (const row of history.results ?? []) {
      const list = historyByEmployee.get(row.employeeId) ?? [];
      list.push(row);
      historyByEmployee.set(row.employeeId, list);
    }
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
      return {
        employeeId: employee.id,
        employeeName: employee.fullName,
        companyId: store?.companyId ?? "",
        companyName: company?.name ?? store?.companyName ?? "",
        cnpj: String(company?.cnpj || "").replace(/\D+/g, ""),
        carry,
        premiumCents: Number(current?.commercialPremiumCents || 0) + Number(current?.premiumsCents || 0),
        overtimeCents: overtimeByEmployee.get(employee.id) ?? 0,
      };
    });
    return jsonResponse({ month, ...buildAccountingReport(people) });
  } catch (error) {
    console.error("Não foi possível montar o relatório da contabilidade.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O RELATÓRIO DA CONTABILIDADE." }, 500);
  }
}
