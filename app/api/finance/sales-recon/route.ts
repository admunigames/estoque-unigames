import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { classifySaleKind, normalizePaymentMethod } from "../../../lib/sales-recon";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import { scopeActorOf, type Statement } from "../card-fees/shared";
import { loadMatchContext, matchReconRow, monthRange, resolveCompany } from "./shared";

// Conciliação de Vendas (Financeiro 6/9) — VENDAS DO PONTTIE.
// GET ?month&companyId: linhas do mês (UNIDADE = loja da venda OU unidade do
// faturamento). POST: importa um arquivo do Ponttie já lido no front
// ({rows, referenceMonth, companyId = LOJA DO ARQUIVO, dryRun}); a prévia
// vem do servidor (dryRun) e a mesma venda (loja + data + nº + forma +
// valor) já importada é pulada.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
type RawRow = Record<string, unknown>;

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
  const month = safeText(params.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  const companyId = allStores ? safeText(params.get("companyId"), 80) : scopeActor.companyId;
  const { from, to } = monthRange(month);
  const values: unknown[] = [from, to];
  if (companyId) values.push(companyId);

  try {
    const database = await getD1();
    const [result, companies] = await Promise.all([
      database
        .prepare(
          `SELECT r.id, r.company_id AS companyId, r.sale_date AS saleDate, r.sale_ref AS saleRef,
                  r.description, r.payment_method AS paymentMethod, r.installments, r.amount_cents AS amountCents,
                  r.authorization_code AS authorizationCode, r.terminal_ref AS terminalRef, r.kind,
                  r.kind_source AS kindSource, r.machine_id AS machineId, r.revenue_company_id AS revenueCompanyId,
                  r.card_sale_id AS cardSaleId, r.bank_entry_id AS bankEntryId, r.status, r.notes,
                  m.acquirer_name || ' ' || m.model || ' ' || CASE WHEN m.terminal <> '' THEN m.terminal ELSE m.serial END AS machineLabel
           FROM finance_sales_recon_rows r
           LEFT JOIN finance_card_machines m ON m.id = r.machine_id
           WHERE r.sale_date >= ?1 AND r.sale_date <= ?2
             ${companyId ? (allStores ? "AND (r.company_id = ?3 OR r.revenue_company_id = ?3)" : "AND r.company_id = ?3") : ""}
           ORDER BY r.sale_date ASC, r.sale_ref ASC, r.id ASC
           LIMIT 5000`,
        )
        .bind(...values)
        .all(),
      loadCompanyList(database),
    ]);
    return jsonResponse({ month, rows: result.results ?? [], companies: companies.map((c) => ({ id: c.id, name: c.name })) });
  } catch (error) {
    console.error("Não foi possível carregar as vendas do Ponttie.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS VENDAS DO PONTTIE." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA IMPORTAR VENDAS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const referenceMonth = safeText(body.referenceMonth, 7);
    const dryRun = body.dryRun === true;
    const rawRows = Array.isArray(body.rows) ? (body.rows as RawRow[]) : [];
    if (!MONTH_PATTERN.test(referenceMonth)) return jsonResponse({ error: "INFORME O MÊS DE REFERÊNCIA (AAAA-MM)." }, 400);
    if (!rawRows.length) return jsonResponse({ error: "O ARQUIVO NÃO TEM LINHAS PARA IMPORTAR." }, 400);
    if (rawRows.length > 5000) return jsonResponse({ error: "ARQUIVO GRANDE DEMAIS (MÁX. 5000 LINHAS)." }, 400);

    const database = await getD1();
    const companies = await loadCompanyList(database);
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    const fileCompanyId = safeText(body.companyId, 80);
    if (fileCompanyId && !companyName.has(fileCompanyId)) return jsonResponse({ error: "LOJA DO ARQUIVO NÃO ENCONTRADA." }, 400);

    const parsed = rawRows.map((raw, index) => {
      const line = Math.round(Number(raw.line)) || index + 2;
      const saleDate = safeText(raw.saleDate, 10);
      const amountCents = Math.round(Number(raw.amountCents) || 0);
      const storeText = safeText(raw.store, 120);
      const companyId = storeText ? resolveCompany(companies, storeText) : fileCompanyId;
      const paymentMethod = normalizePaymentMethod(raw.payment);
      const base = {
        line,
        saleDate,
        saleRef: safeText(raw.saleRef, 60),
        description: safeText(raw.description, 160),
        paymentMethod,
        installments: Math.max(1, Math.round(Number(raw.installments) || 1)),
        amountCents,
        authorizationCode: safeText(raw.authorization, 60),
        terminalRef: safeText(raw.terminal, 60),
        kind: classifySaleKind({ type: raw.type, description: raw.description, serviceOrder: raw.serviceOrder }),
        companyId,
      };
      let rejected = "";
      if (!DATE_RE.test(saleDate) || amountCents <= 0) rejected = "DATA OU VALOR INVÁLIDO";
      else if (!companyId) rejected = storeText ? `LOJA "${storeText}" NÃO ENCONTRADA NO CADASTRO` : "INFORME A LOJA DO ARQUIVO";
      else if (!allStores && companyId !== scopeActor.companyId) rejected = "VENDA DE OUTRA LOJA";
      return { ...base, rejected };
    });

    const valid = parsed.filter((row) => !row.rejected);
    const dates = valid.map((row) => row.saleDate).sort();
    const ctx = dates.length ? await loadMatchContext(database, { from: dates[0], to: dates[dates.length - 1] }) : null;
    const counts = new Map<string, number>();
    const keyOf = (row: { companyId: string; saleDate: string; saleRef: string; paymentMethod: string; amountCents: number }) =>
      `${row.companyId}|${row.saleDate}|${row.saleRef}|${row.paymentMethod}|${Number(row.amountCents)}`;
    if (dates.length) {
      const existing = await database
        .prepare(
          `SELECT company_id AS companyId, sale_date AS saleDate, sale_ref AS saleRef, payment_method AS paymentMethod,
                  amount_cents AS amountCents
           FROM finance_sales_recon_rows WHERE sale_date >= ?1 AND sale_date <= ?2`,
        )
        .bind(dates[0], dates[dates.length - 1])
        .all<{ companyId: string; saleDate: string; saleRef: string; paymentMethod: string; amountCents: number }>();
      for (const row of existing.results ?? []) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
    }

    const planned = parsed.map((row) => {
      if (row.rejected || !ctx) return { ...row, duplicate: false };
      const left = counts.get(keyOf(row)) ?? 0;
      if (left > 0) {
        counts.set(keyOf(row), left - 1);
        return { ...row, duplicate: true };
      }
      const match = matchReconRow(ctx, row);
      return {
        ...row,
        duplicate: false,
        ...match,
        companyName: companyName.get(row.companyId) ?? "",
        revenueCompanyName: companyName.get(match.revenueCompanyId) ?? "",
      };
    });

    const toInsert = planned.filter((row) => !row.rejected && !row.duplicate) as Array<
      (typeof planned)[number] & ReturnType<typeof matchReconRow>
    >;
    const skipped = planned
      .filter((row) => row.rejected || row.duplicate)
      .map((row) => ({ line: row.line, reason: row.rejected || "JÁ IMPORTADA" }));
    const summary = {
      toInsert: toInsert.length,
      inserted: dryRun ? 0 : toInsert.length,
      skipped,
      serviceCount: toInsert.filter((row) => row.kind === "service").length,
      cardNotFound: toInsert.filter((row) => row.status === "not_found" || row.status === "divergent").length,
    };
    if (dryRun) {
      return jsonResponse({
        dryRun: true,
        ...summary,
        rows: planned.map((row) => ({ ...row, companyName: companyName.get(row.companyId) ?? "" })),
      });
    }
    if (!toInsert.length) return jsonResponse({ imported: true, ...summary });

    const importId = crypto.randomUUID();
    const who = actor.displayName || "Administrador";
    const singleCompany = new Set(toInsert.map((row) => row.companyId)).size === 1 ? toInsert[0].companyId : "";
    const statements: Statement[] = [
      [
        `INSERT INTO finance_sales_recon_imports
          (id, company_id, reference_month, source_name, file_hash, row_count, created_by, created_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        [importId, singleCompany, referenceMonth, safeText(body.sourceName, 200), safeText(body.fileHash, 200), toInsert.length, actor.id, who],
      ],
      ...toInsert.map((row): Statement => [
        `INSERT INTO finance_sales_recon_rows
          (id, import_id, company_id, sale_date, sale_ref, description, payment_method, installments, amount_cents,
           authorization_code, terminal_ref, kind, kind_source, machine_id, revenue_company_id, card_sale_id,
           bank_entry_id, status, created_by, created_by_name, updated_by, updated_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'auto', ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?18, ?19)`,
        [
          crypto.randomUUID(), importId, row.companyId, row.saleDate, row.saleRef, row.description, row.paymentMethod,
          row.installments, row.amountCents, row.authorizationCode, row.terminalRef, row.kind, row.machineId,
          row.revenueCompanyId, row.cardSaleId, row.bankEntryId, row.status, actor.id, who,
        ],
      ]),
    ];
    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ imported: true, importId, ...summary }, 201);
  } catch (error) {
    console.error("Não foi possível importar o arquivo do Ponttie.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR O ARQUIVO DO PONTTIE." }, 500);
  }
}
