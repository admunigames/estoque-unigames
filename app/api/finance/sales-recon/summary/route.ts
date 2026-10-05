import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { todayInTimezone } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, loadCompanyList, MONTH_PATTERN, safeText } from "../../shared";
import { scopeActorOf } from "../../card-fees/shared";
import { buildRevenuePlan, loadDepositDays, monthRange } from "../shared";

// RESUMO DO MÊS (Financeiro 6/9): por unidade do faturamento (cada loja e a
// ASSISTÊNCIA) VENDAS · SERVIÇOS · TOTAL e por forma de pagamento; cards de
// conciliação; faturamento ATUAL × NOVO para o diálogo "ATUALIZAR
// FATURAMENTO DO MÊS". Linhas IGNORADAS ficam fora. Login com loja só vê o
// que entra na própria loja.

type CountRow = { paymentMethod: string; status: string; count: number; amountCents: number };

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  const scopeCompanyId = allStores ? "" : scopeActor.companyId;

  try {
    const database = await getD1();
    const { from, to } = monthRange(month);
    const [units, companies, counts, deposits] = await Promise.all([
      buildRevenuePlan(database, month, scopeCompanyId),
      loadCompanyList(database),
      database
        .prepare(
          `SELECT payment_method AS paymentMethod, status, COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS amountCents
           FROM finance_sales_recon_rows WHERE sale_date >= ?1 AND sale_date <= ?2
             ${scopeCompanyId ? "AND revenue_company_id = ?3" : ""}
           GROUP BY payment_method, status`,
        )
        .bind(...[from, to, ...(scopeCompanyId ? [scopeCompanyId] : [])])
        .all<CountRow>(),
      loadDepositDays(database, { from, to, companyId: scopeCompanyId, today: todayInTimezone() }),
    ]);
    const name = new Map(companies.map((c) => [c.id, c.name]));
    const rows = (counts.results ?? []).map((row) => ({ ...row, count: Number(row.count), amountCents: Number(row.amountCents) }));
    const sum = (fn: (row: CountRow) => boolean) =>
      rows.filter(fn).reduce((acc, row) => ({ count: acc.count + row.count, amountCents: acc.amountCents + row.amountCents }), { count: 0, amountCents: 0 });
    const isCard = (row: CountRow) => row.paymentMethod === "debit" || row.paymentMethod === "credit";
    return jsonResponse({
      month,
      cards: {
        total: sum((row) => row.status !== "ignored"),
        cardMatched: sum((row) => isCard(row) && row.status === "matched"),
        divergent: sum((row) => isCard(row) && row.status === "divergent"),
        notFound: sum((row) => isCard(row) && row.status === "not_found"),
        pixPending: sum((row) => row.paymentMethod === "pix" && row.status === "pending"),
        ignored: sum((row) => row.status === "ignored"),
        depositsDivergent: deposits.days.filter((day) => ["divergent", "not_deposited", "deposit_without_sale"].includes(day.status)).length,
      },
      units: units.map((unit) => ({ ...unit, companyName: name.get(unit.companyId) ?? unit.companyId ?? "—" })),
    });
  } catch (error) {
    console.error("Não foi possível montar o resumo da conciliação de vendas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O RESUMO DO MÊS." }, 500);
  }
}
