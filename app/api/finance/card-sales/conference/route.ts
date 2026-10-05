import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, loadCompanyList, safeText } from "../../shared";
import { scopeActorOf } from "../../card-fees/shared";

// Aba CONFERÊNCIA (Financeiro 5/9): vendas com taxa cobrada DIVERGENTE da
// cadastrada ou SEM TAXA CADASTRADA no período, com resumo por adquirente
// (quantidade divergente e "cobrado a mais" = soma das diferenças positivas).
// status: '' (divergentes + sem taxa, revisadas ou não) | divergent | missing | reviewed.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Row = {
  id: string;
  saleDate: string;
  companyId: string;
  machineId: string;
  machineLabel: string | null;
  terminalRef: string;
  acquirerName: string;
  brand: string;
  modality: string;
  installments: number;
  grossCents: number;
  feeBps: number;
  expectedFeeCents: number;
  chargedFeeCents: number | null;
  feeMissing: number;
  feeCheck: string;
  reviewedAt: string;
  reviewedByName: string;
  reviewedNote: string;
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
  const from = safeText(params.get("from"), 10);
  const to = safeText(params.get("to"), 10);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return jsonResponse({ error: "INFORME O PERÍODO." }, 400);
  const companyId = allStores ? safeText(params.get("companyId"), 80) : scopeActor.companyId;
  const machineId = safeText(params.get("machineId"), 80);
  const acquirerId = safeText(params.get("acquirerId"), 80);
  const status = safeText(params.get("status"), 12);

  const conditions = ["s.sale_date >= ?1", "s.sale_date <= ?2", "(s.fee_check = 'divergent' OR s.fee_missing = 1)"];
  const values: unknown[] = [from, to];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(sql.replace("?", `?${values.length}`));
  };
  if (companyId) add("s.company_id = ?", companyId);
  if (machineId) add("s.machine_id = ?", machineId);
  if (acquirerId) add("s.acquirer_id = ?", acquirerId);
  if (status === "divergent") conditions.push("s.fee_check = 'divergent' AND s.reviewed_at = ''");
  else if (status === "missing") conditions.push("s.fee_missing = 1 AND s.reviewed_at = ''");
  else if (status === "reviewed") conditions.push("s.reviewed_at <> ''");

  try {
    const database = await getD1();
    const [result, companies] = await Promise.all([
      database
        .prepare(
          `SELECT s.id, s.sale_date AS saleDate, s.company_id AS companyId, s.machine_id AS machineId,
                  m.acquirer_name || ' ' || m.model || ' ' || CASE WHEN m.terminal <> '' THEN m.terminal ELSE m.serial END AS machineLabel,
                  s.terminal_ref AS terminalRef, s.acquirer_name AS acquirerName, s.brand, s.modality,
                  s.installments, s.gross_cents AS grossCents, s.fee_bps AS feeBps,
                  s.expected_fee_cents AS expectedFeeCents, s.charged_fee_cents AS chargedFeeCents,
                  s.fee_missing AS feeMissing, s.fee_check AS feeCheck, s.reviewed_at AS reviewedAt,
                  s.reviewed_by_name AS reviewedByName, s.reviewed_note AS reviewedNote
           FROM finance_card_sales s
           LEFT JOIN finance_card_machines m ON m.id = s.machine_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY s.sale_date DESC, s.id ASC
           LIMIT 1000`,
        )
        .bind(...values)
        .all<Row>(),
      loadCompanyList(database),
    ]);
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    const rows = (result.results ?? []).map((row) => {
      const charged = row.chargedFeeCents === null || row.chargedFeeCents === undefined ? null : Number(row.chargedFeeCents);
      return {
        ...row,
        companyName: companyName.get(row.companyId) ?? "",
        machineLabel: row.machineLabel || row.terminalRef || "",
        chargedFeeCents: charged,
        differenceCents: charged === null || Number(row.feeMissing) ? null : charged - Number(row.expectedFeeCents),
      };
    });
    const byAcquirer = new Map<string, { acquirerName: string; divergentCount: number; overchargedCents: number }>();
    for (const row of rows) {
      const item = byAcquirer.get(row.acquirerName) ?? { acquirerName: row.acquirerName || "—", divergentCount: 0, overchargedCents: 0 };
      if (row.feeCheck === "divergent") item.divergentCount += 1;
      if (row.differenceCents !== null && row.differenceCents > 0) item.overchargedCents += row.differenceCents;
      byAcquirer.set(row.acquirerName, item);
    }
    const summary = [...byAcquirer.values()].sort((a, b) => b.overchargedCents - a.overchargedCents);
    return jsonResponse({
      rows,
      summary,
      totals: {
        divergentCount: summary.reduce((sum, item) => sum + item.divergentCount, 0),
        missingCount: rows.filter((row) => Number(row.feeMissing)).length,
        overchargedCents: summary.reduce((sum, item) => sum + item.overchargedCents, 0),
      },
    });
  } catch (error) {
    console.error("Não foi possível carregar a conferência de taxas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A CONFERÊNCIA DE TAXAS." }, 500);
  }
}
