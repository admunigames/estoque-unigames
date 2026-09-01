import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Controle de Reposição (Financeiro — Fase 8). Registra valores repostos/
// gastos por Assistência, Logística e outros setores. "Adicionar como
// Despesa" é feito pelo front (POST /finance/expenses) que devolve o
// expense_id via PATCH aqui — a lógica de despesa/DRE não é duplicada.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SECTORS = new Set(["assistencia", "logistica", "outros"]);
const KINDS = new Set([
  "entrada",
  "saida",
  "reposicao",
  "ressarcimento",
  "prejuizo",
  "recuperacao",
]);
// Só os tipos de saída de dinheiro podem virar Despesa.
const EXPENSE_ELIGIBLE_KINDS = new Set(["saida", "reposicao", "ressarcimento", "prejuizo"]);

type Row = Record<string, unknown>;

const SELECT_COLUMNS = `id, entry_date AS entryDate, company_id AS companyId, company_name AS companyName,
  product, reason, sector, responsible_name AS responsibleName, amount_cents AS amountCents,
  kind, notes, expense_id AS expenseId,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const params = new URL(request.url).searchParams;
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (fragment: string, value: unknown) => {
    values.push(value);
    conditions.push(fragment.replace("?", `?${values.length}`));
  };

  const companyId = safeText(params.get("companyId"), 80);
  if (companyId) add("company_id = ?", companyId);
  const sector = safeText(params.get("sector"), 20);
  if (SECTORS.has(sector)) add("sector = ?", sector);
  const kind = safeText(params.get("kind"), 20);
  if (KINDS.has(kind)) add("kind = ?", kind);
  const monthFrom = safeText(params.get("monthFrom"), 7);
  if (MONTH_PATTERN.test(monthFrom)) add("entry_date >= ?", `${monthFrom}-01`);
  const monthTo = safeText(params.get("monthTo"), 7);
  if (MONTH_PATTERN.test(monthTo)) add("entry_date <= ?", `${monthTo}-31`);
  const search = safeText(params.get("search"), 120);
  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(product ILIKE ?${values.length} OR reason ILIKE ?${values.length} OR responsible_name ILIKE ?${values.length})`,
    );
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM finance_replacement_entries
         ${whereSql} ORDER BY entry_date DESC, created_at DESC LIMIT 1000`,
      )
      .bind(...values)
      .all<Row>();
    const bySector = await database
      .prepare(
        `SELECT sector, kind, COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS totalCents
         FROM finance_replacement_entries ${whereSql}
         GROUP BY sector, kind`,
      )
      .bind(...values)
      .all<Row>();
    return jsonResponse({ rows: rows.results ?? [], breakdown: bySector.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o controle de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CONTROLE DE REPOSIÇÃO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR NO CONTROLE DE REPOSIÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const entryDate = safeText(body.entryDate, 10);
    if (!DATE_PATTERN.test(entryDate)) return jsonResponse({ error: "INFORME A DATA." }, 400);
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A UNIDADE." }, 400);
    const product = safeText(body.product, 200);
    if (product.length < 2) return jsonResponse({ error: "INFORME O PRODUTO." }, 400);
    const reason = safeText(body.reason, 500);
    const sector = safeText(body.sector, 20);
    if (!SECTORS.has(sector)) return jsonResponse({ error: "SELECIONE O SETOR RESPONSÁVEL." }, 400);
    const responsibleName = safeText(body.responsibleName, 160);
    const kind = safeText(body.kind, 20);
    if (!KINDS.has(kind)) return jsonResponse({ error: "SELECIONE O TIPO DO LANÇAMENTO." }, 400);
    const notes = safeText(body.notes, 2000);
    const amountCents = Number(body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }

    const database = await getD1();
    const who = actor.displayName || "Administrador";

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM finance_replacement_entries WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE finance_replacement_entries
           SET entry_date=?1, company_id=?2, company_name=?3, product=?4, reason=?5,
               sector=?6, responsible_name=?7, amount_cents=?8, kind=?9, notes=?10,
               updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP
           WHERE id=?13`,
        )
        .bind(
          entryDate, companyId, companyName, product, reason, sector, responsibleName,
          amountCents, kind, notes, actor.id, who, editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_replacement_entries
          (id, entry_date, company_id, company_name, product, reason, sector, responsible_name,
           amount_cents, kind, notes, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,CURRENT_TIMESTAMP,?12,?13,CURRENT_TIMESTAMP)`,
      )
      .bind(
        id, entryDate, companyId, companyName, product, reason, sector, responsibleName,
        amountCents, kind, notes, actor.id, who,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o lançamento de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LANÇAMENTO." }, 500);
  }
}

// Vincula (ou desvincula) o lançamento a uma Despesa já criada pelo front.
export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O CONTROLE DE REPOSIÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const expenseId = safeText(body.expenseId, 80);
    if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, kind, expense_id AS expenseId FROM finance_replacement_entries WHERE id=?1")
      .bind(id)
      .first<{ id: string; kind: string; expenseId: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
    if (expenseId && !EXPENSE_ELIGIBLE_KINDS.has(existing.kind)) {
      return jsonResponse(
        { error: "SÓ LANÇAMENTOS DE SAÍDA DE DINHEIRO PODEM VIRAR DESPESA." },
        400,
      );
    }
    await database
      .prepare(
        `UPDATE finance_replacement_entries
         SET expense_id=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
      )
      .bind(expenseId, actor.id, actor.displayName || "Administrador", id)
      .run();
    return jsonResponse({ updated: true, id, expenseId });
  } catch (error) {
    console.error("Não foi possível vincular a despesa ao lançamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL VINCULAR A DESPESA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR LANÇAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT expense_id AS expenseId FROM finance_replacement_entries WHERE id=?1")
      .bind(id)
      .first<{ expenseId: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
    if (existing.expenseId) {
      return jsonResponse(
        { error: "ESTE LANÇAMENTO JÁ VIROU DESPESA — REMOVA A DESPESA PRIMEIRO." },
        409,
      );
    }
    await database.prepare("DELETE FROM finance_replacement_entries WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO." }, 500);
  }
}
