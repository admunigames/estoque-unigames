import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

type EntryRow = {
  id: string;
  storeId: string;
  itemId: string;
  month: string;
  entryType: string;
  amountCents: number | null;
  percentBasisPoints: number | null;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." },
      403,
    );
  }

  const url = new URL(request.url);
  const storeId = safeText(url.searchParams.get("storeId"), 80);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!storeId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, store_id AS storeId, item_id AS itemId, month, entry_type AS entryType,
                amount_cents AS amountCents, percent_basis_points AS percentBasisPoints,
                updated_by AS updatedBy, updated_by_name AS updatedByName,
                updated_at AS updatedAt
         FROM finance_store_entries
         WHERE store_id=?1 AND month=?2`,
      )
      .bind(storeId, month)
      .all<EntryRow>();
    return jsonResponse({ entries: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os lançamentos financeiros.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS LANÇAMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR VALORES." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const storeId = safeText(body.storeId, 80);
    const itemId = safeText(body.itemId, 80);
    const month = safeText(body.month, 7);
    const entryType = safeText(body.entryType, 20);
    if (!storeId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    if (!itemId) return jsonResponse({ error: "ITEM INVÁLIDO." }, 400);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    }
    if (entryType !== "fixed" && entryType !== "percentage") {
      return jsonResponse({ error: "TIPO DE LANÇAMENTO INVÁLIDO." }, 400);
    }

    let amountCents: number | null = null;
    let percentBasisPoints: number | null = null;
    if (entryType === "fixed") {
      const raw = Number(body.amountCents);
      if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
        return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
      }
      amountCents = raw;
    } else {
      const raw = Number(body.percentBasisPoints);
      if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
        return jsonResponse({ error: "INFORME UM PERCENTUAL VÁLIDO." }, 400);
      }
      percentBasisPoints = raw;
    }

    const database = await getD1();
    const item = await database
      .prepare("SELECT id FROM finance_items WHERE id=?1")
      .bind(itemId)
      .first<{ id: string }>();
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 400);

    const existing = await database
      .prepare(
        "SELECT id FROM finance_store_entries WHERE store_id=?1 AND item_id=?2 AND month=?3",
      )
      .bind(storeId, itemId, month)
      .first<{ id: string }>();

    if (existing) {
      await database
        .prepare(
          `UPDATE finance_store_entries
           SET entry_type=?1, amount_cents=?2, percent_basis_points=?3,
               updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
           WHERE id=?6`,
        )
        .bind(
          entryType,
          amountCents,
          percentBasisPoints,
          actor.id,
          actor.displayName || "Administrador",
          existing.id,
        )
        .run();
      return jsonResponse({ updated: true, id: existing.id });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_store_entries
          (id, store_id, item_id, month, entry_type, amount_cents, percent_basis_points,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP, ?8, ?9, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        storeId,
        itemId,
        month,
        entryType,
        amountCents,
        percentBasisPoints,
        actor.id,
        actor.displayName || "Administrador",
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o lançamento financeiro.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LANÇAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR LANÇAMENTOS." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    await database
      .prepare("DELETE FROM finance_store_entries WHERE id=?1")
      .bind(id)
      .run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento financeiro.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO." }, 500);
  }
}
