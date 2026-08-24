import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { quickViewDueRange, todayInTimezone, type QuickView } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText } from "../../shared";

const QUICK_VIEWS: QuickView[] = [
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

// Números dos cards de atalho (Hoje/Amanhã/.../Vencidos/Pagos) num único
// GET, já filtrados por loja/permissão — evita 9 requisições separadas do
// front e garante que os atalhos e a listagem usam exatamente a mesma
// definição de intervalo (ver quickViewDueRange, fonte única).
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const url = new URL(request.url);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  if (!allStores && companyId && companyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? companyId : scopeActor.companyId;

  const today = todayInTimezone();

  try {
    const database = await getD1();
    const baseCondition = effectiveCompanyId ? "company_id=?1" : "1=1";
    const baseParams: unknown[] = effectiveCompanyId ? [effectiveCompanyId] : [];

    const results: Record<string, { count: number; originalCents: number; paidCents: number; balanceCents: number }> = {};

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
        .first<{ count: number; originalCents: number; paidCents: number; balanceCents: number }>();

      results[view] = {
        count: Number(row?.count ?? 0),
        originalCents: Number(row?.originalCents ?? 0),
        paidCents: Number(row?.paidCents ?? 0),
        balanceCents: Number(row?.balanceCents ?? 0),
      };
    }

    // Fornecedores em aberto: agrupado por fornecedor, só quem tem saldo.
    const openSuppliers = await database
      .prepare(
        `SELECT s.id AS supplierId, s.name AS supplierName,
                COUNT(*) AS count,
                COALESCE(SUM(a.original_amount_cents - a.paid_amount_cents), 0) AS balanceCents
         FROM accounts_payable a
         JOIN finance_suppliers s ON s.id = a.supplier_id
         WHERE ${baseCondition} AND a.status NOT IN ('canceled', 'paid') AND a.supplier_id != ''
         GROUP BY s.id, s.name
         HAVING COALESCE(SUM(a.original_amount_cents - a.paid_amount_cents), 0) > 0
         ORDER BY balanceCents DESC`,
      )
      .bind(...baseParams)
      .all();

    return jsonResponse({ today, quickViews: results, openSuppliers: openSuppliers.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o resumo de contas a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RESUMO." }, 500);
  }
}

