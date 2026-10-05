import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { summarizeCardFeeTotals } from "../../../../lib/card-fees";
import { canManageFinance, identity, jsonResponse, loadCompanyList, MONTH_PATTERN, safeText } from "../../shared";
import { scopeActorOf } from "../shared";

// Aba TOTAL DE TAXAS (Financeiro 5/9; substitui o relatório mensal): soma no
// servidor o que foi pago em taxas no período (mês de/até) — cobrada do
// arquivo quando houver, senão a cadastrada — com as quebras LOJAS ×
// ASSISTÊNCIA, por unidade, por maquineta e por adquirente/bandeira
// (app/lib/card-fees.ts#summarizeCardFeeTotals). Mesmo escopo de loja.

type SaleRow = {
  companyId: string;
  machineId: string;
  machineLabel: string | null;
  terminalRef: string;
  acquirerName: string;
  brand: string;
  grossCents: number;
  expectedFeeCents: number;
  chargedFeeCents: number | null;
  feeMissing: number;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  const params = new URL(request.url).searchParams;
  const from = safeText(params.get("from"), 7);
  const to = safeText(params.get("to"), 7) || from;
  if (!MONTH_PATTERN.test(from) || !MONTH_PATTERN.test(to) || to < from) {
    return jsonResponse({ error: "INFORME O PERÍODO (MÊS DE/ATÉ)." }, 400);
  }
  const acquirerId = safeText(params.get("acquirerId"), 80);
  const conditions = ["s.sale_date >= ?1", "s.sale_date <= ?2"];
  const values: unknown[] = [`${from}-01`, `${to}-31`];
  if (!allStores) {
    values.push(scopeActor.companyId);
    conditions.push(`s.company_id = ?${values.length}`);
  }
  if (acquirerId) {
    values.push(acquirerId);
    conditions.push(`s.acquirer_id = ?${values.length}`);
  }

  try {
    const database = await getD1();
    const [result, companies] = await Promise.all([
      database
        .prepare(
          `SELECT s.company_id AS companyId, s.machine_id AS machineId,
                  m.acquirer_name || ' ' || m.model || ' ' || CASE WHEN m.terminal <> '' THEN m.terminal ELSE m.serial END AS machineLabel,
                  s.terminal_ref AS terminalRef, s.acquirer_name AS acquirerName, s.brand,
                  s.gross_cents AS grossCents, s.expected_fee_cents AS expectedFeeCents,
                  s.charged_fee_cents AS chargedFeeCents, s.fee_missing AS feeMissing
           FROM finance_card_sales s
           LEFT JOIN finance_card_machines m ON m.id = s.machine_id
           WHERE ${conditions.join(" AND ")}`,
        )
        .bind(...values)
        .all<SaleRow>(),
      loadCompanyList(database),
    ]);
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    const summary = summarizeCardFeeTotals(
      (result.results ?? []).map((row) => ({
        companyId: row.companyId,
        companyName: companyName.get(row.companyId) ?? "",
        machineId: row.machineId,
        machineLabel: row.machineLabel || "",
        acquirerName: row.acquirerName || "—",
        brand: row.brand || "",
        grossCents: Number(row.grossCents || 0),
        expectedFeeCents: Number(row.expectedFeeCents || 0),
        chargedFeeCents: row.chargedFeeCents === null || row.chargedFeeCents === undefined ? null : Number(row.chargedFeeCents),
        feeMissing: Boolean(Number(row.feeMissing)),
      })),
    );
    return jsonResponse({ from, to, ...summary });
  } catch (error) {
    console.error("Não foi possível somar as taxas de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SOMAR AS TAXAS DE CARTÃO." }, 500);
  }
}
