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
  actorName,
  canManagePayroll,
  identity,
  jsonResponse,
  loadMonthValues,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Relatório COMISSIONAMENTO / HORAS / PREMIAÇÃO para a contabilidade (RH >
// Relatório Contabilidade; atalho no grupo RH Financeiro do menu). Desde
// 23/10/2026 só três colunas, agrupadas por EMPRESA (CNPJ do cadastro de
// Lojas, pela loja atuante do mês):
//   COMISSIONAMENTO = comissão (Comercial ou digitada) + bônus + ajustes,
//     com o desconto aplicado — se o desconto passar da comissão, a sobra vai
//     para o mês seguinte (app/lib/hr-accounting-report.ts);
//   HORAS EXTRAS = QUANTIDADE de horas (minutos) digitada à mão no próprio
//     relatório (hr_employee_month_values, kind 'he_min') — não soma no R$;
//   PREMIAÇÃO = do Comercial + premiações lançadas no RH.
// OBSERVAÇÕES por empresa (CNPJ) e competência: hr_accounting_notes (PUT).
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
    const [employeesResult, history, overtimeByEmployee, actingStores, companies, notesResult] = await Promise.all([
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
      loadMonthValues(database, month, "he_min"),
      actingStoresForMonth(database, month),
      loadCompanyList(database) as Promise<Array<{ id: string; name: string; cnpj?: string }>>,
      database.prepare("SELECT cnpj, notes FROM hr_accounting_notes WHERE month=?1").bind(month).all<{ cnpj: string; notes: string }>(),
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
        overtimeMinutes: overtimeByEmployee.get(employee.id) ?? 0,
      };
    });
    const notes = new Map((notesResult.results ?? []).map((row) => [row.cnpj, row.notes]));
    return jsonResponse({ month, ...buildAccountingReport(people, notes) });
  } catch (error) {
    console.error("Não foi possível montar o relatório da contabilidade.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O RELATÓRIO DA CONTABILIDADE." }, 500);
  }
}

const MAX_NOTES = 2000;

/** OBSERVAÇÕES de uma empresa (CNPJ; '' = SEM CNPJ) no mês; texto vazio apaga. */
export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    const cnpj = safeText(body.cnpj, 30).replace(/\D+/g, "");
    const notes = safeText(body.notes, MAX_NOTES);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    if (cnpj && cnpj.length !== 14) return jsonResponse({ error: "CNPJ INVÁLIDO." }, 400);
    const database = await getD1();
    if (!notes) {
      await database.prepare("DELETE FROM hr_accounting_notes WHERE cnpj=?1 AND month=?2").bind(cnpj, month).run();
    } else {
      await database
        .prepare(
          `INSERT INTO hr_accounting_notes (id, cnpj, month, notes, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
           ON CONFLICT (cnpj, month) DO UPDATE
             SET notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by,
                 updated_by_name = EXCLUDED.updated_by_name, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(crypto.randomUUID(), cnpj, month, notes, actor.id, actorName(actor))
        .run();
    }
    return jsonResponse({ month, cnpj, notes: notes.toLocaleUpperCase("pt-BR") });
  } catch (error) {
    console.error("Não foi possível gravar as observações da contabilidade.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR AS OBSERVAÇÕES." }, 500);
  }
}
