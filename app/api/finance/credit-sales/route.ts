import { getD1 } from "../../../../db";
import { creditSaleDifference, creditSaleStatus } from "../../../lib/credit-sales";
import { addDays, todayInTimezone } from "../../../lib/finance-status";
import { jsonResponse, loadCompanyList, MONTH_PATTERN, safeText, type JsonMap } from "../shared";
import { runStatements } from "../card-fees/shared";
import {
  CREDIT_SALE_COLUMNS,
  creditScope,
  loadProviders,
  loadTakenProposals,
  normalizeCreditSale,
  planCreditSale,
  type CreditSaleRow,
} from "./shared";

// Crediários (Financeiro 7/9).
// GET ?companyId&month&providerId&status&q&bankEntryId: lista + cards.
// GET ?lookupSaleRef&companyId: a venda existe no Ponttie (Conciliação de
//   Vendas)? Só aviso, nunca bloqueia.
// POST: NOVO CREDIÁRIO (proposta repetida na financeira → 409).

export async function GET(request: Request) {
  const scope = creditScope(request, false);
  if (scope instanceof Response) return scope;
  const params = new URL(request.url).searchParams;
  const companyId = scope.allStores ? safeText(params.get("companyId"), 80) : scope.companyId;

  try {
    const database = await getD1();
    const lookup = safeText(params.get("lookupSaleRef"), 60);
    if (lookup) {
      const sale = await database
        .prepare(
          `SELECT sale_date AS saleDate, SUM(amount_cents) AS amountCents FROM finance_sales_recon_rows
           WHERE company_id=?1 AND sale_ref=?2 GROUP BY sale_date ORDER BY sale_date DESC LIMIT 1`,
        )
        .bind(companyId, lookup)
        .first<{ saleDate: string; amountCents: number }>();
      return jsonResponse({ ponttie: sale ? { saleDate: sale.saleDate, amountCents: Number(sale.amountCents) } : null });
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (companyId) {
      values.push(companyId);
      conditions.push(`company_id=?${values.length}`);
    }
    const providerId = safeText(params.get("providerId"), 80);
    if (providerId) {
      values.push(providerId);
      conditions.push(`provider_id=?${values.length}`);
    }
    // ponytail: carrega todos os crediários da unidade/financeira (os cards
    // somam pendentes de qualquer mês); agregar no SQL se passar de milhares.
    const result = await database
      .prepare(
        `SELECT ${CREDIT_SALE_COLUMNS} FROM finance_credit_sales
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY sale_date DESC, created_at DESC`,
      )
      .bind(...values)
      .all<CreditSaleRow>();
    const today = todayInTimezone();
    const month = safeText(params.get("month"), 7);
    const cardMonth = MONTH_PATTERN.test(month) ? month : today.slice(0, 7);
    const old = addDays(today, -30);
    const all = (result.results ?? []).map(normalizeCreditSale).map((row) => ({
      ...row,
      status: creditSaleStatus(row),
      differenceCents: creditSaleDifference(row),
    }));

    const summary = { pendingCents: 0, pendingCount: 0, pendingOver30: 0, finishedMonthCents: 0, feesMonthCents: 0, month: cardMonth };
    for (const row of all) {
      if (row.status === "pending") {
        summary.pendingCents += row.netCents;
        summary.pendingCount += 1;
        if (row.saleDate < old) summary.pendingOver30 += 1;
      }
      if (row.status === "finished" && row.receivedDate.startsWith(cardMonth)) summary.finishedMonthCents += row.receivedCents;
      if (row.status !== "canceled" && row.saleDate.startsWith(cardMonth)) summary.feesMonthCents += row.feeCents;
    }

    const status = safeText(params.get("status"), 12);
    const q = safeText(params.get("q"), 60).toUpperCase();
    const bankEntryId = safeText(params.get("bankEntryId"), 80);
    const rows = all.filter(
      (row) =>
        (!MONTH_PATTERN.test(month) || bankEntryId || row.saleDate.startsWith(month)) &&
        (!status || row.status === status || (status === "difference" && row.differenceCents !== 0)) &&
        (!q || row.proposal.toUpperCase().includes(q) || row.saleRef.toUpperCase().includes(q)) &&
        (!bankEntryId || row.bankEntryId === bankEntryId),
    );
    return jsonResponse({ today, summary, creditSales: rows });
  } catch (error) {
    console.error("Não foi possível carregar os crediários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS CREDIÁRIOS." }, 500);
  }
}

export async function POST(request: Request) {
  const scope = creditScope(request, true);
  if (scope instanceof Response) return scope;
  try {
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const providerId = safeText(body.providerId, 80);
    const [companies, providers, taken] = await Promise.all([
      loadCompanyList(database),
      loadProviders(database, scope),
      loadTakenProposals(database, providerId ? [providerId] : []),
    ]);
    const plan = planCreditSale({ scope, companies, providers: new Map(providers.map((row) => [row.id, row])), taken }, body);
    if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
    await runStatements(database, [plan.statement]);
    return jsonResponse({ created: true, id: plan.id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o crediário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O CREDIÁRIO." }, 500);
  }
}
