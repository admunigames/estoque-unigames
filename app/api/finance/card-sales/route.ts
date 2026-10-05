import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  computeCardReconStatus,
  computeDivergenceCents,
  computeFeeCheck,
  computeSaleFinance,
  isCardModality,
  isCardReconStatus,
  resolveCardFee,
  resolveChargedFeeCents,
  type CardModality,
} from "../../../lib/card-fees";
import {
  machineCompanyAt,
  matchCardMachine,
  type MachineForMatch,
  type MachineTransfer,
} from "../../../lib/card-machines";
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
import { loadCardFees, scopeActorOf, type Database } from "../card-fees/shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const recon = safeText(params.get("recon"), 12); // '', 'pending', 'ok', 'attention', 'reviewed'

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
    if (isCardReconStatus(recon)) {
      values.push(recon);
      conditions.push(`recon_status=?${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await database
      .prepare(
        `SELECT id, sale_date AS saleDate, acquirer_name AS acquirerName, brand, modality, installments,
                nsu, gross_cents AS grossCents, fee_bps AS feeBps, expected_fee_cents AS expectedFeeCents,
                net_cents AS netCents, fee_missing AS feeMissing,
                received_amount_cents AS receivedAmountCents, divergence_cents AS divergenceCents,
                settled_at AS settledAt, recon_status AS reconStatus, reviewed_at AS reviewedAt,
                reviewed_by_name AS reviewedByName, reviewed_note AS reviewedNote
         FROM finance_card_sales ${where}
         ORDER BY
           CASE recon_status WHEN 'attention' THEN 0 WHEN 'pending' THEN 1 WHEN 'reviewed' THEN 2 ELSE 3 END,
           sale_date DESC, id ASC
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
                COALESCE(SUM(CASE WHEN recon_status = 'attention' THEN 1 ELSE 0 END),0) AS attentionCount,
                COALESCE(SUM(CASE WHEN recon_status = 'reviewed' THEN 1 ELSE 0 END),0) AS reviewedCount,
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

    const database = await getD1();
    const companies = await loadCompanyList(database);
    const companyName = companies.find((row) => row.id === companyId)?.name ?? "";
    const who = actor.displayName || "Administrador";

    if (kind === "sales") {
      return jsonResponse(
        await importSales(database, {
          rows: rawRows,
          defaultCompanyId: companyName ? companyId : "",
          scopeCompanyId: allStores ? "" : scopeActor.companyId,
          companies,
          referenceMonth,
          sourceName,
          fileHash,
          dryRun: body.dryRun === true,
          actor: { id: actor.id, name: who },
        }),
        body.dryRun === true ? 200 : 201,
      );
    }

    if (!hasCompany(companyId)) return jsonResponse({ error: "SELECIONE A UNIDADE." }, 400);
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

    const importId = crypto.randomUUID();
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
  } catch (error) {
    console.error("Não foi possível importar as vendas de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR AS VENDAS DE CARTÃO." }, 500);
  }
}

type MachineRow = MachineForMatch & {
  acquirerId: string;
  acquirerName: string;
  companyName: string;
  label: string;
};

async function loadMachinesWithTransfers(database: Database) {
  const [machines, events] = await Promise.all([
    database
      .prepare(
        `SELECT id, acquirer_id AS acquirerId, acquirer_name AS acquirerName, terminal, serial,
                establishment_code AS establishmentCode, company_id AS companyId, company_name AS companyName,
                acquirer_name || ' ' || model || ' ' || CASE WHEN terminal <> '' THEN terminal ELSE serial END AS label
         FROM finance_card_machines`,
      )
      .all<MachineRow>(),
    database
      .prepare(
        `SELECT machine_id AS machineId, event_date AS eventDate, from_company_id AS fromCompanyId,
                from_company_name AS fromCompanyName
         FROM finance_card_machine_events WHERE kind='transfer'`,
      )
      .all<MachineTransfer & { machineId: string }>(),
  ]);
  const transfers = new Map<string, MachineTransfer[]>();
  for (const event of events.results ?? []) {
    transfers.set(event.machineId, [...(transfers.get(event.machineId) ?? []), event]);
  }
  return { machines: machines.results ?? [], transfers };
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Arquivo de vendas (Financeiro 5/9). Para cada linha: maquineta pelo
 * terminal/serial/EC → unidade da maquineta NA DATA (histórico de
 * transferência); sem maquineta conhecida → unidade padrão (sem ela, a linha
 * é recusada). Taxa cadastrada (maquineta → adquirente) × taxa cobrada do
 * arquivo → fee_check; com taxa cobrada, recon_status já sai ok/attention.
 * Mesma venda já importada (unidade + data + NSU + bruto) é pulada. dryRun
 * devolve a prévia linha a linha sem gravar; senão grava numa transação,
 * com um cabeçalho de importação por unidade do arquivo.
 */
async function importSales(
  database: Database,
  input: {
    rows: RawRow[];
    defaultCompanyId: string;
    scopeCompanyId: string;
    companies: { id: string; name: string }[];
    referenceMonth: string;
    sourceName: string;
    fileHash: string;
    dryRun: boolean;
    actor: { id: string; name: string };
  },
) {
  const companyNameOf = new Map(input.companies.map((c) => [c.id, c.name]));
  const [fees, { machines, transfers }, acquirersRows] = await Promise.all([
    loadCardFees(database),
    loadMachinesWithTransfers(database),
    database.prepare("SELECT id, name FROM finance_acquirers").all<{ id: string; name: string }>(),
  ]);
  const acquirerByName = new Map(
    (acquirersRows.results ?? []).map((a) => [a.name.trim().toLowerCase(), a]),
  );

  const planned = input.rows.map((raw, index) => {
    const line = Math.round(num(raw.line)) || index + 2;
    const saleDate = safeText(raw.saleDate, 10);
    const grossCents = Math.round(num(raw.grossCents));
    const refs = [raw.terminal, raw.serial, raw.establishment].map((v) => safeText(v, 60));
    const terminalRef = refs.find(Boolean) ?? "";
    const base = { line, saleDate, grossCents, terminalRef, nsu: safeText(raw.nsu, 60) };
    if (!DATE_RE.test(saleDate) || grossCents <= 0) {
      return { ...base, rejected: "DATA OU VALOR INVÁLIDO" };
    }
    const machine = matchCardMachine(machines, refs);
    let companyId = input.defaultCompanyId;
    if (machine) companyId = machineCompanyAt(machine, transfers.get(machine.id) ?? [], saleDate).companyId;
    if (!companyId) return { ...base, rejected: "MAQUINETA NÃO CADASTRADA (SEM UNIDADE PADRÃO)" };
    if (input.scopeCompanyId && companyId !== input.scopeCompanyId) {
      return { ...base, rejected: "VENDA DE OUTRA UNIDADE" };
    }
    const rawAcquirerName = safeText(raw.acquirerName, 120);
    const rowAcquirer = acquirerByName.get(rawAcquirerName.toLowerCase());
    const acquirerId = machine?.acquirerId || rowAcquirer?.id || "";
    const acquirerName = machine?.acquirerName || rowAcquirer?.name || rawAcquirerName;
    const modalityRaw = safeText(raw.modality, 12).toLowerCase();
    const modality: CardModality = isCardModality(modalityRaw) ? modalityRaw : "credit";
    const installments = modality === "credit" ? Math.max(1, Math.round(num(raw.installments) || 1)) : 1;
    const brand = safeText(raw.brand, 40);
    const fee = acquirerId
      ? resolveCardFee(fees, { acquirerId, brand, modality, installments, date: saleDate, machineId: machine?.id, companyId })
      : null;
    const feeBps = fee ? fee.feeBps + fee.anticipationBps : 0;
    const { expectedFeeCents, netCents } = computeSaleFinance({ grossCents, feeBps });
    const feeMissing = !fee;
    const chargedFeeCents = resolveChargedFeeCents({
      grossCents,
      feeCents: optionalNumber(raw.feeCents),
      feeBps: optionalNumber(raw.feeBps),
      netCents: optionalNumber(raw.netCents),
    });
    const feeCheck = computeFeeCheck({ grossCents, expectedFeeCents, chargedFeeCents, feeMissing });
    const reconStatus = computeCardReconStatus({
      feeMissing,
      grossCents,
      expectedFeeCents,
      receivedCents: chargedFeeCents === null ? null : grossCents - chargedFeeCents,
    });
    return {
      ...base,
      rejected: "",
      duplicate: false,
      machineId: machine?.id ?? "",
      machineLabel: machine?.label ?? "",
      companyId,
      companyName: companyNameOf.get(companyId) ?? "",
      acquirerId,
      acquirerName,
      brand,
      modality,
      installments,
      feeBps,
      expectedFeeCents,
      netCents,
      feeMissing,
      chargedFeeCents,
      differenceCents: chargedFeeCents === null || feeMissing ? null : chargedFeeCents - expectedFeeCents,
      feeCheck,
      reconStatus,
    };
  });

  // JÁ IMPORTADA: conta as vendas que já existem por unidade + data + NSU +
  // bruto e consome uma por linha igual (duas vendas iguais sem NSU no mesmo
  // arquivo continuam sendo duas).
  type Planned = Extract<(typeof planned)[number], { duplicate: boolean }>;
  const valid = planned.filter((row): row is Planned => !row.rejected);
  if (valid.length) {
    const dates = valid.map((row) => row.saleDate).sort();
    const existing = await database
      .prepare(
        `SELECT company_id AS companyId, sale_date AS saleDate, nsu, gross_cents AS grossCents
         FROM finance_card_sales WHERE sale_date >= ?1 AND sale_date <= ?2`,
      )
      .bind(dates[0], dates[dates.length - 1])
      .all<{ companyId: string; saleDate: string; nsu: string; grossCents: number }>();
    const counts = new Map<string, number>();
    const keyOf = (row: { companyId: string; saleDate: string; nsu: string; grossCents: number }) =>
      `${row.companyId}|${row.saleDate}|${row.nsu}|${Number(row.grossCents)}`;
    for (const row of existing.results ?? []) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
    for (const row of valid) {
      const left = counts.get(keyOf(row)) ?? 0;
      if (left > 0) {
        row.duplicate = true;
        counts.set(keyOf(row), left - 1);
      }
    }
  }

  const toInsert = valid.filter((row) => !row.duplicate);
  const skipped = [
    ...planned.filter((row) => row.rejected).map((row) => ({ line: row.line, reason: row.rejected })),
    ...valid.filter((row) => row.duplicate).map((row) => ({ line: row.line, reason: "JÁ IMPORTADA" })),
  ].sort((a, b) => a.line - b.line);
  const summary = {
    inserted: input.dryRun ? 0 : toInsert.length,
    toInsert: toInsert.length,
    skipped,
    divergentCount: toInsert.filter((row) => row.feeCheck === "divergent").length,
    feeMissingCount: toInsert.filter((row) => row.feeMissing).length,
    noMachineCount: toInsert.filter((row) => !row.machineId).length,
  };
  if (input.dryRun) return { dryRun: true, ...summary, rows: planned };
  if (!toInsert.length) return { imported: true, ...summary };

  const importIds = new Map<string, string>();
  const statements: [string, unknown[]][] = [];
  for (const row of toInsert) {
    if (!importIds.has(row.companyId)) importIds.set(row.companyId, crypto.randomUUID());
    statements.push([
      `INSERT INTO finance_card_sales
        (id, import_id, company_id, sale_date, acquirer_id, acquirer_name, brand, modality,
         installments, nsu, gross_cents, fee_bps, expected_fee_cents, net_cents, fee_missing,
         recon_status, machine_id, terminal_ref, charged_fee_cents, fee_check)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
      [
        crypto.randomUUID(), importIds.get(row.companyId), row.companyId, row.saleDate, row.acquirerId,
        row.acquirerName, row.brand, row.modality, row.installments, row.nsu, row.grossCents, row.feeBps,
        row.expectedFeeCents, row.netCents, row.feeMissing ? 1 : 0, row.reconStatus, row.machineId,
        row.terminalRef, row.chargedFeeCents, row.feeCheck,
      ],
    ]);
  }
  for (const [companyId, importId] of importIds) {
    statements.push([
      `INSERT INTO finance_card_sales_imports
        (id, company_id, company_name, kind, reference_month, source_name, file_hash,
         row_count, matched_count, created_by, created_by_name)
       VALUES (?1, ?2, ?3, 'sales', ?4, ?5, ?6, ?7, 0, ?8, ?9)`,
      [
        importId, companyId, companyNameOf.get(companyId) ?? "", input.referenceMonth, input.sourceName,
        input.fileHash, toInsert.filter((row) => row.companyId === companyId).length, input.actor.id, input.actor.name,
      ],
    ]);
  }
  await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
  return { imported: true, ...summary };
}

// Repasse (aba REPASSE provisória — o prompt 6 substitui). Casa por NSU ou
// data + bruto dentro da unidade escolhida; quando a linha traz terminal/
// serial/EC de uma maquineta cadastrada, casa pela maquineta (vendas antigas
// sem maquineta continuam casando pela unidade).
async function importSettlement(
  database: Database,
  input: { importId: string; companyId: string; rows: RawRow[] },
): Promise<{ matched: number; unmatched: number; divergentCount: number; attentionCount: number }> {
  let matched = 0;
  let unmatched = 0;
  let divergentCount = 0;
  let attentionCount = 0;

  const SALE_COLUMNS = `id, net_cents AS netCents, gross_cents AS grossCents,
    expected_fee_cents AS expectedFeeCents, fee_missing AS feeMissing`;
  type SaleMatch = {
    id: string;
    netCents: number;
    grossCents: number;
    expectedFeeCents: number;
    feeMissing: number;
  };

  const { machines } = await loadMachinesWithTransfers(database);
  const settledAt = new Date().toISOString();
  for (const raw of input.rows) {
    const machine = matchCardMachine(machines, [raw.terminal, raw.serial, raw.establishment].map((v) => safeText(v, 60)));
    // ?n = maquineta ('' = só pela unidade, como antes).
    const scope = (n: number) =>
      `((?${n} <> '' AND machine_id=?${n}) OR ((?${n} = '' OR machine_id='') AND company_id=?1))`;
    const machineRef = machine?.id ?? "";
    const nsu = safeText(raw.nsu, 60);
    const saleDate = safeText(raw.saleDate, 10);
    const grossCents = Math.round(num(raw.grossCents));
    const receivedCents = Math.round(num(raw.receivedCents));
    if (receivedCents <= 0 && grossCents <= 0) continue;

    let sale: SaleMatch | null = null;
    if (nsu) {
      sale = await database
        .prepare(
          `SELECT ${SALE_COLUMNS} FROM finance_card_sales
           WHERE ${scope(3)} AND nsu=?2 AND received_amount_cents IS NULL
           ORDER BY sale_date ASC LIMIT 1`,
        )
        .bind(input.companyId, nsu, machineRef)
        .first<SaleMatch>();
    }
    if (!sale && DATE_RE.test(saleDate) && grossCents > 0) {
      sale = await database
        .prepare(
          `SELECT ${SALE_COLUMNS} FROM finance_card_sales
           WHERE ${scope(4)} AND sale_date=?2 AND gross_cents=?3 AND received_amount_cents IS NULL
           ORDER BY id ASC LIMIT 1`,
        )
        .bind(input.companyId, saleDate, grossCents, machineRef)
        .first<SaleMatch>();
    }
    if (!sale) {
      unmatched += 1;
      continue;
    }

    const divergence = computeDivergenceCents(sale.netCents, receivedCents);
    if (divergence !== null && divergence !== 0) divergentCount += 1;
    // Conciliação: com o repasse casado, recalcula o status cruzando a taxa
    // real cobrada com a cadastrada. Um repasse novo sempre reabre a revisão
    // manual anterior (reviewedAt não é passado).
    const reconStatus = computeCardReconStatus({
      feeMissing: Boolean(sale.feeMissing),
      grossCents: sale.grossCents,
      expectedFeeCents: sale.expectedFeeCents,
      receivedCents,
    });
    if (reconStatus === "attention") attentionCount += 1;
    await database
      .prepare(
        `UPDATE finance_card_sales
         SET received_amount_cents=?1, divergence_cents=?2, settlement_import_id=?3, settled_at=?6,
             recon_status=?4, reviewed_at='', reviewed_by='', reviewed_by_name='', reviewed_note=''
         WHERE id=?5`,
      )
      .bind(receivedCents, divergence, input.importId, reconStatus, sale.id, settledAt)
      .run();
    matched += 1;
  }

  return { matched, unmatched, divergentCount, attentionCount };
}
