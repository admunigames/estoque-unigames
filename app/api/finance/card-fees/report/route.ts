import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { summarizeMonthlyFees, type SaleForReport } from "../../../../lib/card-fees";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText } from "../../shared";

// Relatório mensal do custo com taxas de cartão (Financeiro Fase 7).
// Agrega por adquirente + bandeira: venda bruta, taxa prevista, custo real
// (quando há repasse) e divergência. A agregação em si é pura
// (app/lib/card-fees.ts#summarizeMonthlyFees).

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const params = new URL(request.url).searchParams;
  const month = safeText(params.get("month"), 7);
  const companyId = safeText(params.get("companyId"), 80);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  }

  try {
    const database = await getD1();
    const conditions = ["sale_date >= ?1", "sale_date <= ?2"];
    const values: unknown[] = [`${month}-01`, `${month}-31`];
    if (!allStores) {
      values.push(scopeActor.companyId);
      conditions.push(`company_id=?${values.length}`);
    } else if (companyId) {
      values.push(companyId);
      conditions.push(`company_id=?${values.length}`);
    }
    const rows = await database
      .prepare(
        `SELECT acquirer_name AS acquirerName, brand,
                gross_cents AS grossCents, expected_fee_cents AS expectedFeeCents,
                net_cents AS netCents, received_amount_cents AS receivedCents
         FROM finance_card_sales
         WHERE ${conditions.join(" AND ")}`,
      )
      .bind(...values)
      .all<SaleForReport>();

    const summary = summarizeMonthlyFees(
      (rows.results ?? []).map((row) => ({
        acquirerName: row.acquirerName || "—",
        brand: row.brand || "",
        grossCents: Number(row.grossCents || 0),
        expectedFeeCents: Number(row.expectedFeeCents || 0),
        netCents: Number(row.netCents || 0),
        receivedCents:
          row.receivedCents === null || row.receivedCents === undefined
            ? null
            : Number(row.receivedCents),
      })),
    );

    return jsonResponse({ month, ...summary });
  } catch (error) {
    console.error("Não foi possível gerar o relatório de taxas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GERAR O RELATÓRIO DE TAXAS." }, 500);
  }
}
