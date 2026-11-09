import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { machineCompanyAt, matchCardMachine } from "../../../../lib/card-machines";
import { canManageFinance, identity, jsonResponse, loadCompanyList, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../shared";
import { assertFinanceAccountBelongsToCompany } from "../../payables/shared";
import { loadMachinesWithTransfers } from "../../card-fees/shared";
import { resolveCashFlowScope } from "../shared";

// ARQUIVO DE RECEBIMENTOS DO BANCO (Fluxo de Caixa, 09/11/2026). O front lê o
// CSV/XLS (cada banco tem um modelo — as colunas são achadas pelo nome) e
// manda as parcelas já normalizadas. Cada parcela vira uma linha de
// finance_card_receipt_lines; as parcelas da mesma conta + loja + adquirente
// + data de pagamento somam UM recebível em aberto, e as já PAGAS no arquivo
// outro, já recebido (chave com ":PAGO") — assim o dia que está parte pago
// não entra inteiro na projeção. Reimportar move a parcela de grupo; o
// recebível em aberto que fica sem valor é apagado. O arquivo SUBSTITUI a
// estimativa pelas vendas (card-forecast) da mesma loja + adquirente + data.
//
// GET  ?accountId&month=AAAA-MM  → parcelas (vencimento no mês) + totais
// POST {dryRun, financeAccountId, acquirerId, companyId, sourceName, rows[]}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 5000;
const PAID_RE = /^(PAG|LIQUID|RECEBID|EFETIVAD|CREDITAD|QUITAD|CONCLU)/;
type Database = Awaited<ReturnType<typeof getD1>>;

type PlannedLine = {
  lineKey: string;
  groupKey: string;
  companyId: string;
  companyName: string;
  category: string;
  saleDate: string;
  dueDate: string;
  brand: string;
  product: string;
  installments: number;
  installmentNo: number;
  grossCents: number;
  netCents: number;
  feeCents: number;
  statusText: string;
  paid: number;
  saleRef: string;
  establishment: string;
};

const int = (value: unknown) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
};
const upper = (value: unknown, max: number) => safeText(value, max).toUpperCase();

function isPaidReceiptStatus(text: string) {
  return PAID_RE.test(text.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
}

// Cancelamento/estorno/chargeback (ou qualquer valor negativo do arquivo).
function isCancelLine(row: { category: string; netCents: number }) {
  return /CANCEL|ESTORN|CHARGEBACK/.test(row.category) || row.netCents < 0;
}

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403) };
  }
  return { actor };
}

async function selectIn<T>(database: Database, sql: string, values: string[]) {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += 400) {
    const chunk = values.slice(i, i + 400);
    const marks = chunk.map((_, index) => `?${index + 1}`).join(",");
    const result = await database.prepare(sql.replace("(:in)", `(${marks})`)).bind(...chunk).all<T>();
    out.push(...(result.results ?? []));
  }
  return out;
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const params = new URL(request.url).searchParams;
  const scope = resolveCashFlowScope(request, "");
  if (scope.error) return scope.error;
  const month = safeText(params.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS." }, 400);
  const accountId = safeText(params.get("accountId"), 80);
  const values: string[] = [`${month}-01`, `${month}-31`];
  let where = "due_date >= ?1 AND due_date <= ?2";
  if (accountId) {
    values.push(accountId);
    where += ` AND finance_account_id = ?${values.length}`;
  }
  if (scope.companyId) {
    values.push(scope.companyId);
    where += ` AND company_id = ?${values.length}`;
  }
  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, company_name AS companyName, acquirer_name AS acquirerName, category, sale_date AS saleDate,
                due_date AS dueDate, brand, product, installments, installment_no AS installmentNo,
                gross_cents AS grossCents, net_cents AS netCents, fee_cents AS feeCents,
                status_text AS statusText, paid, sale_ref AS saleRef
         FROM finance_card_receipt_lines WHERE ${where}
         ORDER BY due_date, sale_date, sale_ref, installment_no LIMIT 5000`,
      )
      .bind(...values)
      .all();
    return jsonResponse({ month, lines: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível listar os recebimentos do arquivo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LISTAR OS RECEBIMENTOS DO ARQUIVO." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const actor = checked.actor;
  try {
    const body = (await request.json()) as JsonMap;
    const scope = resolveCashFlowScope(request, safeText(body.companyId, 80));
    if (scope.error) return scope.error;
    const dryRun = body.dryRun === true;
    const financeAccountId = safeText(body.financeAccountId, 80);
    const acquirerId = safeText(body.acquirerId, 80);
    const rows = Array.isArray(body.rows) ? (body.rows as JsonMap[]) : [];
    if (!financeAccountId) return jsonResponse({ error: "ESCOLHA A CONTA ONDE OS RECEBIMENTOS CAEM." }, 400);
    if (!acquirerId) return jsonResponse({ error: "ESCOLHA A ADQUIRENTE DO ARQUIVO." }, 400);
    if (!rows.length) return jsonResponse({ error: "O ARQUIVO NÃO TEM PARCELAS." }, 400);
    if (rows.length > MAX_ROWS) return jsonResponse({ error: `ARQUIVO GRANDE DEMAIS (MÁXIMO ${MAX_ROWS} LINHAS).` }, 400);

    const database = await getD1();
    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId);
    if (accountError) return jsonResponse({ error: accountError }, 400);
    const acquirer = await database
      .prepare("SELECT id, name FROM finance_acquirers WHERE id=?1")
      .bind(acquirerId)
      .first<{ id: string; name: string }>();
    if (!acquirer) return jsonResponse({ error: "ADQUIRENTE NÃO ENCONTRADA." }, 400);
    const [companies, { machines, transfers }] = await Promise.all([loadCompanyList(database), loadMachinesWithTransfers(database)]);
    const companyName = new Map(companies.map((row) => [row.id, row.name]));
    const defaultCompanyId = scope.companyId;
    if (defaultCompanyId && !companyName.has(defaultCompanyId)) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);

    // 1) Parcelas do arquivo → linhas planejadas.
    const rejected: { line: number; reason: string }[] = [];
    const planned = new Map<string, PlannedLine>();
    const seen = new Map<string, number>();
    rows.forEach((raw, index) => {
      const line = int(raw.line) || index + 2;
      const dueDate = safeText(raw.dueDate, 10);
      const saleDate = DATE_RE.test(safeText(raw.saleDate, 10)) ? safeText(raw.saleDate, 10) : "";
      const netCents = int(raw.netCents);
      if (!DATE_RE.test(dueDate)) return rejected.push({ line, reason: "SEM DATA DE PAGAMENTO" });
      if (!netCents) return rejected.push({ line, reason: "SEM VALOR LÍQUIDO" });
      const establishment = safeText(raw.establishment, 60);
      const refs = [raw.terminal, raw.serial, establishment].map((value) => safeText(value, 60));
      const machine = matchCardMachine(machines, refs);
      const companyId = machine ? machineCompanyAt(machine, transfers.get(machine.id) ?? [], saleDate || dueDate).companyId : defaultCompanyId;
      if (!companyId) return rejected.push({ line, reason: "LOJA NÃO IDENTIFICADA (ESCOLHA A LOJA)" });
      if (!scope.allStores && companyId !== scope.scopeCompanyId) return rejected.push({ line, reason: "PARCELA DE OUTRA LOJA" });
      const grossCents = int(raw.grossCents) || netCents;
      const installments = Math.max(1, int(raw.installments) || 1);
      const installmentNo = Math.max(1, int(raw.installmentNo) || 1);
      const category = upper(raw.category, 60) || (netCents < 0 ? "AJUSTE" : "VENDA");
      const saleRef = upper(raw.saleRef, 80);
      const statusText = upper(raw.status, 40);
      // Mesma parcela reimportada = mesma chave. Sem identificador da venda,
      // a chave usa os dados da linha + nº da ocorrência no arquivo.
      const base = saleRef
        ? `${acquirerId}|${saleRef}|${installmentNo}/${installments}|${category}`
        : `${acquirerId}|${saleDate}|${dueDate}|${grossCents}|${netCents}|${installmentNo}/${installments}|${category}|${upper(raw.brand, 40)}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      const lineKey = `${base}#${occurrence}`;
      planned.set(lineKey, {
        lineKey,
        groupKey: `card-file:${financeAccountId}:${companyId}:${acquirerId}:${dueDate}${isPaidReceiptStatus(statusText) ? ":PAGO" : ""}`,
        companyId,
        companyName: companyName.get(companyId) ?? "",
        category,
        saleDate,
        dueDate,
        brand: upper(raw.brand, 40),
        product: upper(raw.product, 60),
        installments,
        installmentNo,
        grossCents,
        netCents,
        feeCents: grossCents - netCents,
        statusText,
        paid: isPaidReceiptStatus(statusText) ? 1 : 0,
        saleRef,
        establishment,
      });
    });

    // 2) O que já existe: as mesmas parcelas (podem mudar de dia/conta) e os
    //    dias (grupos) afetados, com todas as suas parcelas.
    type StoredLine = { id: string; lineKey: string; groupKey: string; netCents: number; paid: number; dueDate: string };
    const existing = await selectIn<StoredLine>(
      database,
      `SELECT id, line_key AS lineKey, group_key AS groupKey, net_cents AS netCents, paid, due_date AS dueDate
       FROM finance_card_receipt_lines WHERE line_key IN (:in)`,
      [...planned.keys()],
    );
    const existingByKey = new Map(existing.map((row) => [row.lineKey, row]));
    const groupKeys = new Set([...planned.values()].map((row) => row.groupKey));
    for (const row of existing) groupKeys.add(row.groupKey);
    const groupLines = await selectIn<StoredLine>(
      database,
      `SELECT id, line_key AS lineKey, group_key AS groupKey, net_cents AS netCents, paid, due_date AS dueDate
       FROM finance_card_receipt_lines WHERE group_key IN (:in)`,
      [...groupKeys],
    );
    const merged = new Map<string, { groupKey: string; netCents: number; paid: number; dueDate: string }>();
    for (const row of groupLines) merged.set(row.lineKey, row);
    for (const row of planned.values()) merged.set(row.lineKey, row);
    const receivables = await selectIn<{ id: string; key: string; canceled: number; received: number | null; bankEntryId: string }>(
      database,
      `SELECT id, idempotency_key AS key, canceled, received_amount_cents AS received, bank_entry_id AS bankEntryId
       FROM accounts_receivable WHERE idempotency_key IN (:in)`,
      [...groupKeys],
    );
    const receivableByKey = new Map(receivables.map((row) => [row.key, row]));

    // 3) Um recebível por grupo (dia).
    type Group = {
      key: string;
      date: string;
      companyId: string;
      companyName: string;
      count: number;
      grossCents: number;
      netCents: number;
      paid: boolean;
      action: "new" | "update" | "received" | "locked" | "remove" | "none";
      receivableId: string;
      replacesCents: number;
    };
    const groups = new Map<string, Group>();
    const fromFile = new Map<string, PlannedLine>();
    for (const row of planned.values()) fromFile.set(row.groupKey, row);
    for (const key of groupKeys) {
      const lines = [...merged.values()].filter((row) => row.groupKey === key);
      const sample = fromFile.get(key);
      const [, , companyId = "", , date = ""] = key.split(":");
      const netCents = lines.reduce((sum, row) => sum + row.netCents, 0);
      const paid = key.endsWith(":PAGO");
      const receivable = receivableByKey.get(key);
      // Travado: cancelado, conciliado com o extrato ou (em aberto) recebido à mão.
      const lockedReceivable =
        receivable &&
        (Number(receivable.canceled) === 1 ||
          Boolean(receivable.bankEntryId) ||
          (!paid && receivable.received !== null && receivable.received !== undefined));
      let action: Group["action"];
      if (lockedReceivable) action = "locked";
      else if (netCents <= 0) action = receivable ? "remove" : "none";
      else if (!receivable) action = paid ? "received" : "new";
      else action = paid ? "received" : "update";
      groups.set(key, {
        key,
        date,
        companyId,
        companyName: sample?.companyName ?? companyName.get(companyId) ?? "",
        count: lines.length,
        grossCents: [...planned.values()].filter((row) => row.groupKey === key).reduce((sum, row) => sum + row.grossCents, 0),
        netCents,
        paid,
        action,
        receivableId: receivable?.id ?? "",
        replacesCents: 0,
      });
    }

    // 4) Estimativas (card-forecast) da mesma loja + adquirente + dia, ainda
    //    em aberto, que o arquivo substitui.
    const dates = [...groups.values()].map((group) => group.date).sort();
    const estimates = dates.length
      ? (
          await database
            .prepare(
              `SELECT id, company_id AS companyId, expected_date AS date, expected_amount_cents AS cents
               FROM accounts_receivable
               WHERE idempotency_key LIKE 'card-forecast:%' AND acquirer_id = ?1 AND expected_date >= ?2 AND expected_date <= ?3
                 AND canceled = 0 AND received_amount_cents IS NULL`,
            )
            .bind(acquirerId, dates[0], dates[dates.length - 1])
            .all<{ id: string; companyId: string; date: string; cents: number }>()
        ).results ?? []
      : [];
    const replaced: string[] = [];
    for (const group of groups.values()) {
      if (group.netCents <= 0 || group.action === "locked") continue;
      for (const estimate of estimates) {
        if (estimate.companyId !== group.companyId || estimate.date !== group.date) continue;
        group.replacesCents += Number(estimate.cents) || 0;
        replaced.push(estimate.id);
      }
    }

    const groupList = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.companyName.localeCompare(b.companyName));
    const plannedLines = [...planned.values()];
    const summary = {
      lines: plannedLines.length,
      newLines: plannedLines.filter((row) => !existingByKey.has(row.lineKey)).length,
      updatedLines: plannedLines.filter((row) => existingByKey.has(row.lineKey)).length,
      grossCents: plannedLines.reduce((sum, row) => sum + row.grossCents, 0),
      netCents: plannedLines.reduce((sum, row) => sum + row.netCents, 0),
      paidCents: plannedLines.filter((row) => row.paid).reduce((sum, row) => sum + row.netCents, 0),
      openCents: plannedLines.filter((row) => !row.paid).reduce((sum, row) => sum + row.netCents, 0),
      replacedEstimates: replaced.length,
      cancelLines: plannedLines.filter(isCancelLine).length,
      cancelCents: plannedLines.filter(isCancelLine).reduce((sum, row) => sum + row.netCents, 0),
    };
    if (dryRun) return jsonResponse({ dryRun: true, acquirerName: acquirer.name, summary, groups: groupList, rejected });
    if (!plannedLines.length) return jsonResponse({ error: "NENHUMA PARCELA VÁLIDA NO ARQUIVO." }, 400);

    // 5) Grava tudo numa transação.
    const actorName = actor.displayName || "Administrador";
    const statements = [];
    for (const row of plannedLines) {
      const stored = existingByKey.get(row.lineKey);
      const values = [
        row.groupKey, financeAccountId, row.companyId, row.companyName, acquirerId, acquirer.name, row.category,
        row.saleDate, row.dueDate, row.brand, row.product, row.installments, row.installmentNo, row.grossCents,
        row.netCents, row.feeCents, row.statusText, row.paid, row.saleRef, row.establishment, safeText(body.sourceName, 160),
      ];
      statements.push(
        stored
          ? database
              .prepare(
                `UPDATE finance_card_receipt_lines SET group_key=?1, finance_account_id=?2, company_id=?3, company_name=?4,
                   acquirer_id=?5, acquirer_name=?6, category=?7, sale_date=?8, due_date=?9, brand=?10, product=?11,
                   installments=?12, installment_no=?13, gross_cents=?14, net_cents=?15, fee_cents=?16, status_text=?17,
                   paid=?18, sale_ref=?19, establishment=?20, source_name=?21, updated_at=CURRENT_TIMESTAMP
                 WHERE id=?22`,
              )
              .bind(...values, stored.id)
          : database
              .prepare(
                `INSERT INTO finance_card_receipt_lines
                  (group_key, finance_account_id, company_id, company_name, acquirer_id, acquirer_name, category,
                   sale_date, due_date, brand, product, installments, installment_no, gross_cents, net_cents, fee_cents,
                   status_text, paid, sale_ref, establishment, source_name, id, line_key, created_by, created_by_name,
                   created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                   ?22, ?23, ?24, ?25, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              )
              .bind(...values, crypto.randomUUID(), row.lineKey, actor.id, actorName),
      );
    }
    for (const group of groupList) {
      const notes = `ARQUIVO DO BANCO (${group.count} PARCELA(S))`;
      const received = group.paid ? group.netCents : null;
      const receivedDate = group.paid ? group.date : "";
      if (group.action === "new" || (group.action === "received" && !group.receivableId)) {
        statements.push(
          database
            .prepare(
              `INSERT INTO accounts_receivable
                (id, company_id, company_name, operator_text, acquirer_id, competence_month, expected_date,
                 expected_amount_cents, received_amount_cents, received_date, notes, canceled, idempotency_key,
                 created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, finance_account_id)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?14, CURRENT_TIMESTAMP, ?13, ?14, CURRENT_TIMESTAMP, ?15)`,
            )
            .bind(
              crypto.randomUUID(), group.companyId, group.companyName, acquirer.name, acquirerId, group.date.slice(0, 7),
              group.date, group.netCents, received, receivedDate, notes, group.key, actor.id, actorName, financeAccountId,
            ),
        );
      } else if (group.action === "update" || group.action === "received") {
        statements.push(
          database
            .prepare(
              `UPDATE accounts_receivable SET expected_amount_cents=?1, received_amount_cents=?2, received_date=?3, notes=?4,
                 updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
               WHERE id=?7 AND canceled = 0 AND bank_entry_id = ''`,
            )
            .bind(group.netCents, received, receivedDate, notes, actor.id, actorName, group.receivableId),
        );
      } else if (group.action === "remove") {
        statements.push(
          database
            .prepare("DELETE FROM accounts_receivable WHERE id=?1 AND canceled = 0 AND bank_entry_id = ''")
            .bind(group.receivableId),
        );
      }
    }
    for (const id of replaced) {
      statements.push(
        database
          .prepare(
            `UPDATE accounts_receivable SET canceled=1, canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP,
               notes=CASE WHEN notes='' THEN 'SUBSTITUÍDO PELO ARQUIVO DO BANCO' ELSE notes || ' · SUBSTITUÍDO PELO ARQUIVO DO BANCO' END,
               updated_at=CURRENT_TIMESTAMP
             WHERE id=?3 AND canceled = 0 AND received_amount_cents IS NULL`,
          )
          .bind(actor.id, actorName, id),
      );
    }
    await database.batch(statements);
    return jsonResponse({ ok: true, summary, groups: groupList.length, rejected: rejected.length });
  } catch (error) {
    console.error("Não foi possível importar o arquivo de recebimentos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR O ARQUIVO DE RECEBIMENTOS." }, 500);
  }
}
