import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../../lib/access-scope";
import { hasForbiddenCardKey, parseInstallmentLabel } from "../../../../../lib/corporate-cards";
import {
  canManageFinance,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../../shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type CardScopeRow = { id: string; companyId: string };
type RawEntry = Record<string, unknown>;

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

async function loadCard(database: D1Database, id: string) {
  return database
    .prepare("SELECT id, company_id AS companyId FROM finance_corporate_cards WHERE id=?1")
    .bind(id)
    .first<CardScopeRow>();
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function assertCardAccess(request: Request, actor: ReturnType<typeof identity>, cardId: string) {
  const database = await getD1();
  const card = await loadCard(database, cardId);
  if (!card) return { error: jsonResponse({ error: "CARTÃO NÃO ENCONTRADO." }, 404) };
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  }
  if (!allStores && card.companyId !== scopeActor.companyId) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESTE CARTÃO." }, 403) };
  }
  return { database, card };
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
  const { database } = access;

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
        `SELECT id, entry_date AS entryDate, merchant, amount_cents AS amountCents,
                installment_label AS installmentLabel, installment_current AS installmentCurrent,
                installment_total AS installmentTotal, category_item_id AS categoryItemId,
                cost_center_id AS costCenterId, holder_name AS holderName, notes,
                expense_id AS expenseId, status
         FROM finance_card_invoice_entries
         WHERE ${conditions.join(" AND ")}
         ORDER BY entry_date DESC, id ASC
         LIMIT 2000`,
      )
      .bind(...values)
      .all();
    return jsonResponse({ entries: rows.results ?? [] });
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
    const referenceMonth = safeText(body.referenceMonth, 7);
    const sourceName = safeText(body.sourceName, 200);
    const sourceFormatRaw = safeText(body.sourceFormat, 10).toLowerCase();
    const sourceFormat = ["csv", "xlsx", "ofx", "pdf", "manual"].includes(sourceFormatRaw)
      ? sourceFormatRaw
      : "csv";
    const fileHash = safeText(body.fileHash, 200);
    const rawRows = Array.isArray(body.rows) ? (body.rows as RawEntry[]) : [];
    if (!MONTH_PATTERN.test(referenceMonth)) {
      return jsonResponse({ error: "INFORME O MÊS DA FATURA (AAAA-MM)." }, 400);
    }
    if (!rawRows.length) return jsonResponse({ error: "A FATURA NÃO TEM LANÇAMENTOS." }, 400);
    if (rawRows.length > 3000) return jsonResponse({ error: "FATURA GRANDE DEMAIS (MÁX. 3000 LINHAS)." }, 400);

    if (fileHash) {
      const dup = await database
        .prepare("SELECT id FROM finance_card_invoice_imports WHERE card_id=?1 AND file_hash=?2")
        .bind(cardId, fileHash)
        .first<{ id: string }>();
      if (dup) return jsonResponse({ imported: true, alreadyProcessed: true, importId: dup.id });
    }

    const who = actor.displayName || "Administrador";
    const importId = crypto.randomUUID();
    let inserted = 0;
    for (const raw of rawRows) {
      const entryDate = safeText(raw.entryDate, 10);
      if (!DATE_RE.test(entryDate)) continue;
      const amountCents = Math.round(num(raw.amountCents));
      if (amountCents === 0) continue;
      const merchant = safeText(raw.merchant, 200);
      const installment = parseInstallmentLabel(safeText(raw.installmentLabel, 20));
      const holderName = safeText(raw.holderName, 120);

      await database
        .prepare(
          `INSERT INTO finance_card_invoice_entries
            (id, import_id, card_id, company_id, entry_date, merchant, amount_cents,
             installment_label, installment_current, installment_total, holder_name,
             created_by, created_by_name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          crypto.randomUUID(),
          importId,
          cardId,
          card.companyId,
          entryDate,
          merchant,
          amountCents,
          installment.label,
          installment.current,
          installment.total,
          holderName,
          actor.id,
          who,
        )
        .run();
      inserted += 1;
    }
    if (!inserted) return jsonResponse({ error: "NENHUM LANÇAMENTO VÁLIDO NA FATURA." }, 400);

    await database
      .prepare(
        `INSERT INTO finance_card_invoice_imports
          (id, card_id, reference_month, source_name, source_format, file_hash, row_count,
           created_by, created_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(importId, cardId, referenceMonth, sourceName, sourceFormat, fileHash, inserted, actor.id, who)
      .run();

    return jsonResponse({ imported: true, importId, inserted }, 201);
  } catch (error) {
    console.error("Não foi possível importar a fatura.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR A FATURA." }, 500);
  }
}

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
      .prepare("SELECT id, expense_id AS expenseId FROM finance_card_invoice_entries WHERE id=?1 AND card_id=?2")
      .bind(entryId, cardId)
      .first<{ id: string; expenseId: string }>();
    if (!entry) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);

    // Vincular a uma Despesa já criada (o front chama o POST de /expenses e
    // depois manda o id de volta aqui — a lógica de despesa não é duplicada).
    const expenseId = safeText(body.expenseId, 80);
    if (expenseId) {
      await database
        .prepare(
          "UPDATE finance_card_invoice_entries SET expense_id=?1, status='expensed' WHERE id=?2",
        )
        .bind(expenseId, entryId)
        .run();
      return jsonResponse({ updated: true, id: entryId, status: "expensed" });
    }

    const categoryItemId = safeText(body.categoryItemId, 80);
    const costCenterId = safeText(body.costCenterId, 80);
    const notes = safeText(body.notes, 1000);
    const nextStatus = entry.expenseId ? "expensed" : categoryItemId ? "classified" : "pending";
    await database
      .prepare(
        `UPDATE finance_card_invoice_entries
         SET category_item_id=?1, cost_center_id=?2, notes=?3, status=?4
         WHERE id=?5`,
      )
      .bind(categoryItemId, costCenterId, notes, nextStatus, entryId)
      .run();
    return jsonResponse({ updated: true, id: entryId, status: nextStatus });
  } catch (error) {
    console.error("Não foi possível atualizar o lançamento da fatura.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O LANÇAMENTO." }, 500);
  }
}
