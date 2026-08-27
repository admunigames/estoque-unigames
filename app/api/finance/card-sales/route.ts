import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  computeDivergenceCents,
  computeSaleFinance,
  isCardModality,
  resolveCardFee,
  type CardModality,
} from "../../../lib/card-fees";
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
import { loadCardFees } from "../card-fees/shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

type RawRow = Record<string, unknown>;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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
  const acquirerId = safeText(params.get("acquirerId"), 80);
  const settlement = safeText(params.get("settlement"), 12); // '', 'pending', 'settled'

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (!allStores) {
      values.push(scopeActor.companyId);
      conditions.push(`company_id=?${values.length}`);
    } else if (companyId) {
      values.push(companyId);
      conditions.push(`company_id=?${values.length}`);
    }
    if (MONTH_PATTERN.test(month)) {
      values.push(`${month}-01`, `${month}-31`);
      conditions.push(`sale_date >= ?${values.length - 1} AND sale_date <= ?${values.length}`);
    }
    if (acquirerId) {
      values.push(acquirerId);
      conditions.push(`acquirer_id=?${values.length}`);
    }
    if (settlement === "pending") conditions.push("received_amount_cents IS NULL");
    else if (settlement === "settled") conditions.push("received_amount_cents IS NOT NULL");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await database
      .prepare(
        `SELECT id, sale_date AS saleDate, acquirer_name AS acquirerName, brand, modality, installments,
                nsu, gross_cents AS grossCents, fee_bps AS feeBps, expected_fee_cents AS expectedFeeCents,
                net_cents AS netCents, fee_missing AS feeMissing,
                received_amount_cents AS receivedAmountCents, divergence_cents AS divergenceCents,
                settled_at AS settledAt
         FROM finance_card_sales ${where}
         ORDER BY sale_date DESC, id ASC
         LIMIT 500`,
      )
      .bind(...values)
      .all();

    const totals = await database
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(gross_cents),0) AS grossCents,
                COALESCE(SUM(expected_fee_cents),0) AS expectedFeeCents,
                COALESCE(SUM(net_cents),0) AS netCents,
                COALESCE(SUM(COALESCE(received_amount_cents,0)),0) AS receivedCents,
                COALESCE(SUM(CASE WHEN received_amount_cents IS NULL THEN 1 ELSE 0 END),0) AS pendingCount,
                COALESCE(SUM(COALESCE(divergence_cents,0)),0) AS divergenceCents
         FROM finance_card_sales ${where}`,
      )
      .bind(...values)
      .first<Record<string, number>>();

    return jsonResponse({ rows: rows.results ?? [], totals: totals ?? {} });
  } catch (error) {
    console.error("Não foi possível carregar as vendas de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS VENDAS DE CARTÃO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA IMPORTAR VENDAS DE CARTÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const kind = safeText(body.kind, 12) === "settlement" ? "settlement" : "sales";
    const referenceMonth = safeText(body.referenceMonth, 7);
    const sourceName = safeText(body.sourceName, 200);
    const fileHash = safeText(body.fileHash, 200);
    const rawRows = Array.isArray(body.rows) ? (body.rows as RawRow[]) : [];
    if (!MONTH_PATTERN.test(referenceMonth)) {
      return jsonResponse({ error: "INFORME O MÊS DE REFERÊNCIA (AAAA-MM)." }, 400);
    }
    if (!rawRows.length) return jsonResponse({ error: "O ARQUIVO NÃO TEM LINHAS PARA IMPORTAR." }, 400);
    if (rawRows.length > 5000) return jsonResponse({ error: "ARQUIVO GRANDE DEMAIS (MÁX. 5000 LINHAS)." }, 400);

    let companyId = safeText(body.companyId, 80);
    if (!allStores) companyId = scopeActor.companyId;
    if (!hasCompany(companyId)) return jsonResponse({ error: "SELECIONE A UNIDADE." }, 400);

    const database = await getD1();
    const companies = await loadCompanyList(database);
    const companyName = companies.find((row) => row.id === companyId)?.name ?? "";
    if (!companyName) return jsonResponse({ error: "UNIDADE NÃO ENCONTRADA." }, 400);

    if (fileHash) {
      const dup = await database
        .prepare(
          "SELECT id FROM finance_card_sales_imports WHERE file_hash=?1 AND kind=?2 AND company_id=?3",
        )
        .bind(fileHash, kind, companyId)
        .first<{ id: string }>();
      if (dup) {
        return jsonResponse({ imported: true, alreadyProcessed: true, importId: dup.id });
      }
    }

    const who = actor.displayName || "Administrador";
    const importId = crypto.randomUUID();

    if (kind === "settlement") {
      const result = await importSettlement(database, {
        importId,
        companyId,
        rows: rawRows,
      });
      await database
        .prepare(
          `INSERT INTO finance_card_sales_imports
            (id, company_id, company_name, kind, reference_month, source_name, file_hash,
             row_count, matched_count, created_by, created_by_name)
           VALUES (?1, ?2, ?3, 'settlement', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          importId,
          companyId,
          companyName,
          referenceMonth,
          sourceName,
          fileHash,
          rawRows.length,
          result.matched,
          actor.id,
          who,
        )
        .run();
      return jsonResponse({ imported: true, importId, ...result }, 201);
    }

    // kind === "sales"
    const fees = await loadCardFees(database, companyId);
    const acquirersRows = await database
      .prepare("SELECT id, name FROM finance_acquirers WHERE company_id='' OR company_id=?1")
      .bind(companyId)
      .all<{ id: string; name: string }>();
    const acquirerById = new Map((acquirersRows.results ?? []).map((a) => [a.id, a.name]));
    const acquirerByName = new Map(
      (acquirersRows.results ?? []).map((a) => [a.name.trim().toLowerCase(), a.id]),
    );

    let inserted = 0;
    let feeMissingCount = 0;
    for (const raw of rawRows) {
      const saleDate = safeText(raw.saleDate, 10);
      if (!DATE_RE.test(saleDate)) continue;
      const grossCents = Math.round(num(raw.grossCents));
      if (grossCents <= 0) continue;

      let acquirerId = safeText(raw.acquirerId, 80);
      const rawAcquirerName = safeText(raw.acquirerName, 120);
      if (!acquirerId && rawAcquirerName) {
        acquirerId = acquirerByName.get(rawAcquirerName.trim().toLowerCase()) ?? "";
      }
      const acquirerName = acquirerById.get(acquirerId) ?? rawAcquirerName;

      const modalityRaw = safeText(raw.modality, 12).toLowerCase();
      const modality: CardModality = isCardModality(modalityRaw) ? modalityRaw : "credit";
      const installments = Math.max(1, Math.round(num(raw.installments) || 1));
      const brand = safeText(raw.brand, 40);
      const nsu = safeText(raw.nsu, 60);

      const fee = acquirerId
        ? resolveCardFee(fees, { acquirerId, brand, modality, installments, date: saleDate })
        : null;
      const feeBps = fee ? fee.feeBps : 0;
      const anticipationBps = fee ? fee.anticipationBps : 0;
      const { expectedFeeCents, netCents } = computeSaleFinance({ grossCents, feeBps, anticipationBps });
      const feeMissing = fee ? 0 : 1;
      if (feeMissing) feeMissingCount += 1;

      await database
        .prepare(
          `INSERT INTO finance_card_sales
            (id, import_id, company_id, sale_date, acquirer_id, acquirer_name, brand, modality,
             installments, nsu, gross_cents, fee_bps, expected_fee_cents, net_cents, fee_missing)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
        )
        .bind(
          crypto.randomUUID(),
          importId,
          companyId,
          saleDate,
          acquirerId,
          acquirerName,
          brand,
          modality,
          installments,
          nsu,
          grossCents,
          feeBps + anticipationBps,
          expectedFeeCents,
          netCents,
          feeMissing,
        )
        .run();
      inserted += 1;
    }

    if (!inserted) {
      return jsonResponse({ error: "NENHUMA LINHA VÁLIDA ENCONTRADA NO ARQUIVO." }, 400);
    }

    await database
      .prepare(
        `INSERT INTO finance_card_sales_imports
          (id, company_id, company_name, kind, reference_month, source_name, file_hash,
           row_count, matched_count, created_by, created_by_name)
         VALUES (?1, ?2, ?3, 'sales', ?4, ?5, ?6, ?7, 0, ?8, ?9)`,
      )
      .bind(importId, companyId, companyName, referenceMonth, sourceName, fileHash, inserted, actor.id, who)
      .run();

    return jsonResponse({ imported: true, importId, inserted, feeMissingCount }, 201);
  } catch (error) {
    console.error("Não foi possível importar as vendas de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR AS VENDAS DE CARTÃO." }, 500);
  }
}

async function importSettlement(
  database: Awaited<ReturnType<typeof getD1>>,
  input: { importId: string; companyId: string; rows: RawRow[] },
): Promise<{ matched: number; unmatched: number; divergentCount: number }> {
  let matched = 0;
  let unmatched = 0;
  let divergentCount = 0;

  for (const raw of input.rows) {
    const nsu = safeText(raw.nsu, 60);
    const saleDate = safeText(raw.saleDate, 10);
    const grossCents = Math.round(num(raw.grossCents));
    const receivedCents = Math.round(num(raw.receivedCents));
    if (receivedCents <= 0 && grossCents <= 0) continue;

    let sale: { id: string; netCents: number } | null = null;
    if (nsu) {
      sale = await database
        .prepare(
          `SELECT id, net_cents AS netCents FROM finance_card_sales
           WHERE company_id=?1 AND nsu=?2 AND received_amount_cents IS NULL
           ORDER BY sale_date ASC LIMIT 1`,
        )
        .bind(input.companyId, nsu)
        .first<{ id: string; netCents: number }>();
    }
    if (!sale && DATE_RE.test(saleDate) && grossCents > 0) {
      sale = await database
        .prepare(
          `SELECT id, net_cents AS netCents FROM finance_card_sales
           WHERE company_id=?1 AND sale_date=?2 AND gross_cents=?3 AND received_amount_cents IS NULL
           ORDER BY id ASC LIMIT 1`,
        )
        .bind(input.companyId, saleDate, grossCents)
        .first<{ id: string; netCents: number }>();
    }
    if (!sale) {
      unmatched += 1;
      continue;
    }

    const divergence = computeDivergenceCents(sale.netCents, receivedCents);
    if (divergence !== null && divergence !== 0) divergentCount += 1;
    await database
      .prepare(
        `UPDATE finance_card_sales
         SET received_amount_cents=?1, divergence_cents=?2, settlement_import_id=?3, settled_at=now()::text
         WHERE id=?4`,
      )
      .bind(receivedCents, divergence, input.importId, sale.id)
      .run();
    matched += 1;
  }

  return { matched, unmatched, divergentCount };
}
