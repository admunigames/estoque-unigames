import { unauthorizedResponse } from "../../../../../lib/notion";
import {
  applyCardEntryFields,
  cardEntryDuplicateKey,
  hasForbiddenCardKey,
  parseInstallmentLabel,
  possibleExpenseDuplicates,
  shiftIsoDate,
} from "../../../../../lib/corporate-cards";
import {
  canManageFinance,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../../shared";
import { assertCardAccess, ENTRY_COLUMNS, parseCardEntryFields, type StoredCardEntry } from "../../shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type RawEntry = Record<string, unknown>;
type Database = Exclude<Awaited<ReturnType<typeof assertCardAccess>>["database"], undefined>;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

type ParsedRow = {
  index: number;
  entryDate: string;
  merchant: string;
  amountCents: number;
  installment: { current: number; total: number; label: string };
  holderName: string;
  allowDuplicate: boolean;
};

function parseRows(rawRows: RawEntry[]): ParsedRow[] {
  const rows: ParsedRow[] = [];
  rawRows.forEach((raw, index) => {
    const entryDate = safeText(raw?.entryDate, 10);
    const amountCents = Math.round(num(raw?.amountCents));
    if (!DATE_RE.test(entryDate) || amountCents === 0) return;
    rows.push({
      index,
      entryDate,
      merchant: safeText(raw.merchant, 200),
      amountCents,
      installment: parseInstallmentLabel(safeText(raw.installmentLabel, 20)),
      holderName: safeText(raw.holderName, 120),
      allowDuplicate: raw.allowDuplicate === true,
    });
  });
  return rows;
}

const rowKey = (row: ParsedRow) =>
  cardEntryDuplicateKey({
    entryDate: row.entryDate,
    amountCents: row.amountCents,
    merchant: row.merchant,
    installmentCurrent: row.installment.current,
    installmentTotal: row.installment.total,
  });

/** Chaves dos lançamentos já gravados no cartão, no intervalo de datas das linhas. */
async function existingKeys(database: Database, cardId: string, rows: ParsedRow[]) {
  if (!rows.length) return new Set<string>();
  const dates = rows.map((r) => r.entryDate).sort();
  const existing = await database
    .prepare(
      `SELECT entry_date AS entryDate, amount_cents AS amountCents, merchant,
              installment_current AS installmentCurrent, installment_total AS installmentTotal
       FROM finance_card_invoice_entries WHERE card_id=?1 AND entry_date >= ?2 AND entry_date <= ?3`,
    )
    .bind(cardId, dates[0], dates[dates.length - 1])
    .all<{ entryDate: string; amountCents: number; merchant: string; installmentCurrent: number; installmentTotal: number }>();
  return new Set((existing.results ?? []).map(cardEntryDuplicateKey));
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const { id } = await context.params;
  const cardId = safeText(id, 80);
  const access = await assertCardAccess(request, actor, cardId);
  if (access.error) return access.error;
  const { database, card } = access;

  const params = new URL(request.url).searchParams;
  const month = safeText(params.get("month"), 7);

  try {
    const conditions = ["card_id=?1"];
    const values: unknown[] = [cardId];
    if (MONTH_PATTERN.test(month)) {
      values.push(`${month}-01`, `${month}-31`);
      conditions.push(`entry_date >= ?2 AND entry_date <= ?3`);
    }
    const rows = await database
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM finance_card_invoice_entries
         WHERE ${conditions.join(" AND ")}
         ORDER BY entry_date DESC, id ASC
         LIMIT 2000`,
      )
      .bind(...values)
      .all<StoredCardEntry>();
    const entries = rows.results ?? [];

    // POSSÍVEL DUPLICADO EM DESPESAS: Despesa da mesma loja, mesmo valor,
    // data a ±3 dias e sem vínculo com nenhum lançamento de cartão.
    let flagged = new Set<string>();
    const open = entries.filter((e) => !e.expenseId && e.status !== "not_expense");
    if (open.length) {
      const dates = open.map((e) => e.entryDate).sort();
      const from = shiftIsoDate(dates[0], -3);
      const to = shiftIsoDate(dates[dates.length - 1], 3);
      const expenses = await database
        .prepare(
          `SELECT x.issue_date AS issueDate, x.due_date AS dueDate, x.original_amount_cents AS amountCents
           FROM expenses x
           WHERE x.company_id=?1
             AND ((x.issue_date >= ?2 AND x.issue_date <= ?3) OR (x.issue_date = '' AND x.due_date >= ?2 AND x.due_date <= ?3))
             AND NOT EXISTS (SELECT 1 FROM finance_card_invoice_entries c WHERE c.expense_id = x.id)`,
        )
        .bind(card.companyId, from, to)
        .all<{ issueDate: string; dueDate: string; amountCents: number }>();
      flagged = possibleExpenseDuplicates(
        open,
        (expenses.results ?? []).map((x) => ({ date: x.issueDate || x.dueDate, amountCents: Number(x.amountCents) })),
      );
    }

    const holders = await database
      .prepare("SELECT full_name AS name FROM hr_employees WHERE status='active' ORDER BY full_name ASC LIMIT 2000")
      .all<{ name: string }>();
    return jsonResponse({
      entries: entries.map((e) => ({ ...e, possibleExpenseDuplicate: flagged.has(e.id) })),
      holderSuggestions: (holders.results ?? []).map((h) => h.name).filter(Boolean),
    });
  } catch (error) {
    console.error("Não foi possível carregar a fatura.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A FATURA." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA IMPORTAR FATURAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const cardId = safeText(id, 80);
  const access = await assertCardAccess(request, actor, cardId);
  if (access.error) return access.error;
  const { database, card } = access;

  try {
    const body = (await request.json()) as JsonMap;
    if (hasForbiddenCardKey(body)) {
      return jsonResponse({ error: "DADOS DE SENHA OU CVV NÃO SÃO ACEITOS." }, 400);
    }
    const rawRows = Array.isArray(body.rows) ? (body.rows as RawEntry[]) : [];
    if (rawRows.some((raw) => raw && typeof raw === "object" && hasForbiddenCardKey(raw))) {
      return jsonResponse({ error: "DADOS DE SENHA OU CVV NÃO SÃO ACEITOS." }, 400);
    }
    if (!rawRows.length) return jsonResponse({ error: "A FATURA NÃO TEM LANÇAMENTOS." }, 400);
    if (rawRows.length > 3000) return jsonResponse({ error: "FATURA GRANDE DEMAIS (MÁX. 3000 LINHAS)." }, 400);
    const rows = parseRows(rawRows);
    const known = await existingKeys(database, cardId, rows);

    // Prévia: só diz quais linhas (índice no envio) já estão cadastradas.
    if (body.dryRun === true) {
      return jsonResponse({ duplicates: rows.filter((row) => known.has(rowKey(row))).map((row) => row.index) });
    }

    const referenceMonth = safeText(body.referenceMonth, 7);
    if (!MONTH_PATTERN.test(referenceMonth)) {
      return jsonResponse({ error: "INFORME O MÊS DA FATURA (AAAA-MM)." }, 400);
    }
    if (!rows.length) return jsonResponse({ error: "NENHUM LANÇAMENTO VÁLIDO NA FATURA." }, 400);
    const sourceName = safeText(body.sourceName, 200);
    const sourceFormatRaw = safeText(body.sourceFormat, 10).toLowerCase();
    const sourceFormat = ["csv", "xlsx", "ofx", "pdf", "manual"].includes(sourceFormatRaw) ? sourceFormatRaw : "csv";
    const fileHash = safeText(body.fileHash, 200);

    // Duplicada (mesma data + valor + estabelecimento + parcela já no cartão)
    // só entra se veio marcada de propósito na prévia.
    const toInsert = rows.filter((row) => row.allowDuplicate || !known.has(rowKey(row)));
    const skippedDuplicates = rows.length - toInsert.length;
    if (!toInsert.length) {
      return jsonResponse({ imported: false, inserted: 0, skippedDuplicates });
    }

    const who = actor.displayName || "Administrador";
    const importId = crypto.randomUUID();
    const statements = toInsert.map((row) =>
      database
        .prepare(
          `INSERT INTO finance_card_invoice_entries
            (id, import_id, card_id, company_id, entry_date, merchant, amount_cents,
             installment_label, installment_current, installment_total, holder_name,
             created_by, created_by_name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          crypto.randomUUID(), importId, cardId, card.companyId, row.entryDate, row.merchant, row.amountCents,
          row.installment.label, row.installment.current, row.installment.total, row.holderName, actor.id, who,
        ),
    );
    statements.push(
      database
        .prepare(
          `INSERT INTO finance_card_invoice_imports
            (id, card_id, reference_month, source_name, source_format, file_hash, row_count,
             created_by, created_by_name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(importId, cardId, referenceMonth, sourceName, sourceFormat, fileHash, toInsert.length, actor.id, who),
    );
    await database.batch(statements);
    return jsonResponse({ imported: true, importId, inserted: toInsert.length, skippedDuplicates }, 201);
  } catch (error) {
    console.error("Não foi possível importar a fatura.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR A FATURA." }, 500);
  }
}

// Edita UM lançamento: só os campos enviados (categoria, centro de custo,
// responsável, observação, expenseKind 'expense' | 'not_expense'). Mantém o
// vínculo antigo { entryId, expenseId } para Despesa criada fora daqui.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR A FATURA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const cardId = safeText(id, 80);
  const access = await assertCardAccess(request, actor, cardId);
  if (access.error) return access.error;
  const { database } = access;

  try {
    const body = (await request.json()) as JsonMap;
    const entryId = safeText(body.entryId, 80);
    if (!entryId) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
    const entry = await database
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM finance_card_invoice_entries WHERE id=?1 AND card_id=?2`)
      .bind(entryId, cardId)
      .first<StoredCardEntry>();
    if (!entry) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);

    const expenseId = safeText(body.expenseId, 80);
    if (expenseId) {
      if (entry.status === "not_expense") {
        return jsonResponse({ error: "LANÇAMENTO MARCADO COMO NÃO É DESPESA — VOLTE PARA PENDENTE ANTES." }, 409);
      }
      await database
        .prepare("UPDATE finance_card_invoice_entries SET expense_id=?1, status='expensed' WHERE id=?2")
        .bind(expenseId, entryId)
        .run();
      return jsonResponse({ updated: true, id: entryId, status: "expensed" });
    }

    const next = applyCardEntryFields(entry, parseCardEntryFields(body));
    if ("error" in next) return jsonResponse({ error: next.error }, 409);
    await database
      .prepare(
        `UPDATE finance_card_invoice_entries
         SET category_item_id=?1, cost_center_id=?2, holder_name=?3, notes=?4, status=?5
         WHERE id=?6`,
      )
      .bind(next.categoryItemId, next.costCenterId, next.holderName, next.notes, next.status, entryId)
      .run();
    return jsonResponse({ updated: true, id: entryId, status: next.status });
  } catch (error) {
    console.error("Não foi possível atualizar o lançamento da fatura.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O LANÇAMENTO." }, 500);
  }
}
