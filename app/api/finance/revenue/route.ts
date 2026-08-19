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

type RevenueRow = {
  id: string;
  storeId: string;
  month: string;
  amountCents: number;
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
    const revenue = await database
      .prepare(
        `SELECT id, store_id AS storeId, month, amount_cents AS amountCents,
                updated_by AS updatedBy, updated_by_name AS updatedByName,
                updated_at AS updatedAt
         FROM finance_store_revenue
         WHERE store_id=?1 AND month=?2`,
      )
      .bind(storeId, month)
      .first<RevenueRow>();
    return jsonResponse({ revenue: revenue ?? null });
  } catch (error) {
    console.error("Não foi possível carregar a receita financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A RECEITA." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR A RECEITA." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const storeId = safeText(body.storeId, 80);
    const month = safeText(body.month, 7);
    const rawAmount = Number(body.amountCents);
    if (!storeId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    }
    if (!Number.isFinite(rawAmount) || rawAmount < 0 || !Number.isInteger(rawAmount)) {
      return jsonResponse({ error: "INFORME UM VALOR DE RECEITA VÁLIDO." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM finance_store_revenue WHERE store_id=?1 AND month=?2")
      .bind(storeId, month)
      .first<{ id: string }>();

    if (existing) {
      await database
        .prepare(
          `UPDATE finance_store_revenue
           SET amount_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
           WHERE id=?4`,
        )
        .bind(rawAmount, actor.id, actor.displayName || "Administrador", existing.id)
        .run();
      return jsonResponse({ updated: true, id: existing.id });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_store_revenue
          (id, store_id, month, amount_cents, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, ?5, ?6, CURRENT_TIMESTAMP)`,
      )
      .bind(id, storeId, month, rawAmount, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a receita financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A RECEITA." }, 500);
  }
}
