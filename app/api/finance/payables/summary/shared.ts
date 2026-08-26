import type { getD1 } from "../../../../../db";
import { quickViewDueRange, type QuickView } from "../../../../lib/finance-status";

// Extraído de route.ts pra ser reaproveitado pelo Dashboard Geral (Fase 2
// do Financeiro) — os cards "Contas a pagar hoje/na semana/no mês/vencidas"
// e "Principais fornecedores em aberto" usam exatamente a mesma consulta
// que já alimenta os atalhos de Contas a Pagar, numa única fonte.

export const QUICK_VIEWS: QuickView[] = [
  "today",
  "tomorrow",
  "week",
  "next7",
  "next30",
  "month",
  "year",
  "overdue",
  "paid",
];

export type QuickViewStats = { count: number; originalCents: number; paidCents: number; balanceCents: number };

export async function buildPayablesQuickViews(
  database: Awaited<ReturnType<typeof getD1>>,
  effectiveCompanyId: string,
  today: string,
): Promise<Record<string, QuickViewStats>> {
  const baseCondition = effectiveCompanyId ? "company_id=?1" : "1=1";
  const baseParams: unknown[] = effectiveCompanyId ? [effectiveCompanyId] : [];

  const results: Record<string, QuickViewStats> = {};

  for (const view of QUICK_VIEWS) {
    let whereSql = `${baseCondition} AND status != 'canceled'`;
    const values = [...baseParams];

    if (view === "paid") {
      whereSql = `${baseCondition} AND status = 'paid'`;
    } else if (view === "overdue") {
      values.push(today);
      whereSql = `${baseCondition} AND status != 'canceled' AND due_date < ?${values.length} AND status != 'paid'`;
    } else {
      const range = quickViewDueRange(view, today);
      if (range) {
        values.push(range.from, range.to);
        whereSql = `${baseCondition} AND status != 'canceled' AND due_date >= ?${values.length - 1} AND due_date <= ?${values.length}`;
      }
    }

    const row = await database
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(original_amount_cents), 0) AS originalCents,
                COALESCE(SUM(paid_amount_cents), 0) AS paidCents,
                COALESCE(SUM(original_amount_cents - paid_amount_cents), 0) AS balanceCents
         FROM accounts_payable WHERE ${whereSql}`,
      )
      .bind(...values)
      .first<QuickViewStats>();

    results[view] = {
      count: Number(row?.count ?? 0),
      originalCents: Number(row?.originalCents ?? 0),
      paidCents: Number(row?.paidCents ?? 0),
      balanceCents: Number(row?.balanceCents ?? 0),
    };
  }

  return results;
}

export type OpenSupplierRow = { supplierId: string; supplierName: string; count: number; balanceCents: number };

export async function buildOpenSuppliers(
  database: Awaited<ReturnType<typeof getD1>>,
  effectiveCompanyId: string,
): Promise<OpenSupplierRow[]> {
  const baseCondition = effectiveCompanyId ? "company_id=?1" : "1=1";
  const baseParams: unknown[] = effectiveCompanyId ? [effectiveCompanyId] : [];
  const result = await database
    .prepare(
      `SELECT s.id AS supplierId, s.name AS supplierName,
              COUNT(*) AS count,
              COALESCE(SUM(a.original_amount_cents - a.paid_amount_cents), 0) AS balanceCents
       FROM accounts_payable a
       JOIN finance_suppliers s ON s.id = a.supplier_id
       WHERE ${baseCondition} AND a.status NOT IN ('canceled', 'paid') AND a.supplier_id != ''
       GROUP BY s.id, s.name
       HAVING COALESCE(SUM(a.original_amount_cents - a.paid_amount_cents), 0) > 0
       ORDER BY COALESCE(SUM(a.original_amount_cents - a.paid_amount_cents), 0) DESC`,
    )
    .bind(...baseParams)
    .all<OpenSupplierRow>();
  return result.results ?? [];
}
