import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { todayInTimezone } from "../../../../lib/finance-status";
import { buildOpenSuppliers } from "../../payables/summary/shared";
import { identity, jsonResponse, safeText } from "../../shared";
import { canManageSupplierDebts } from "../shared";

// Dashboard de Fornecedores — decisão de UX registrada no PR: em vez de
// duplicar uma query quase idêntica no Dashboard Geral do Financeiro (que
// já expõe topSuppliers, um top 10 de buildOpenSuppliers), estes agregados
// extras (vencido/a vencer/pago no mês/maior devedor/por loja) vivem só
// aqui e alimentam o bloco "geral" no topo da tela de Conta Corrente do
// Fornecedor — reaproveitando buildOpenSuppliers pra não repetir a mesma
// consulta de saldo em aberto por fornecedor em dois lugares.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageSupplierDebts(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR FORNECEDORES EM ABERTO." }, 403);
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

  try {
    const database = await getD1();
    const today = todayInTimezone();
    const monthStart = `${today.slice(0, 7)}-01`;

    const baseCondition = effectiveCompanyId ? "company_id=?1" : "1=1";
    const baseParams: unknown[] = effectiveCompanyId ? [effectiveCompanyId] : [];

    const [openSuppliers, overdueRow, paidThisMonthRow, byStore] = await Promise.all([
      buildOpenSuppliers(database, effectiveCompanyId),
      database
        .prepare(
          `SELECT COALESCE(SUM(original_amount_cents - paid_amount_cents), 0) AS overdueCents
           FROM accounts_payable
           WHERE ${baseCondition} AND supplier_id != '' AND status NOT IN ('canceled','paid') AND due_date < ?${baseParams.length + 1}`,
        )
        .bind(...baseParams, today)
        .first<{ overdueCents: number }>(),
      database
        .prepare(
          `SELECT COALESCE(SUM(p.amount_cents), 0) AS paidCents
           FROM accounts_payable_payments p
           JOIN accounts_payable a ON a.id = p.payable_id
           WHERE a.supplier_id != '' AND (${effectiveCompanyId ? "a.company_id=?1" : "1=1"})
             AND p.scheduled = 0 AND p.payment_date >= ?${baseParams.length + 1}`,
        )
        .bind(...baseParams, monthStart)
        .first<{ paidCents: number }>(),
      database
        .prepare(
          `SELECT company_id AS companyId, company_name AS companyName,
                  COALESCE(SUM(original_amount_cents - paid_amount_cents), 0) AS balanceCents
           FROM accounts_payable
           WHERE ${baseCondition} AND supplier_id != '' AND status NOT IN ('canceled','paid')
           GROUP BY company_id, company_name
           HAVING COALESCE(SUM(original_amount_cents - paid_amount_cents), 0) > 0
           ORDER BY balanceCents DESC`,
        )
        .bind(...baseParams)
        .all<{ companyId: string; companyName: string; balanceCents: number }>(),
    ]);

    const totalOpenCents = openSuppliers.reduce((sum, row) => sum + row.balanceCents, 0);
    const overdueCents = Number(overdueRow?.overdueCents ?? 0);
    const biggestDebtor = openSuppliers[0] ?? null;

    return jsonResponse({
      totalOpenCents,
      overdueCents,
      upcomingCents: totalOpenCents - overdueCents,
      paidThisMonthCents: Number(paidThisMonthRow?.paidCents ?? 0),
      biggestDebtor,
      byStore: byStore.results ?? [],
      bySupplier: openSuppliers,
      today,
    });
  } catch (error) {
    console.error("Não foi possível carregar o dashboard de fornecedores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O DASHBOARD DE FORNECEDORES." }, 500);
  }
}
