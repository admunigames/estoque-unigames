import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import {
  ADJUSTMENT_DATE_PATTERN,
  aggregateLast7Days,
  buildLastNDates,
  classifyGdBalance,
  GD_BALANCE_STATUS_LABELS,
} from "../../lib/controle-gd";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type CompanyEntry = { id: string; name: string };

const LEDGER_DEFAULT_LIMIT = 50;
const LEDGER_MAX_LIMIT = 200;
const MAX_AMOUNT_CENTS = 100_000_000_00; // R$ 100 milhões — teto de sanidade, não um limite de negócio real.

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function can(actor: Identity, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

function canView(actor: Identity) {
  return can(actor, "controle_gd:view") || can(actor, "controle_gd:manage");
}

function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

function todayDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Lista completa de lojas (Cadastros > Lojas), na ordem cadastrada. */
async function loadCompanies(database: D1Database): Promise<CompanyEntry[]> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  try {
    const list = row?.value ? (JSON.parse(row.value) as CompanyEntry[]) : [];
    return Array.isArray(list)
      ? list.filter((item): item is CompanyEntry => Boolean(item) && typeof item.id === "string")
      : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AO CONTROLE GD." }, 403);
  }

  const url = new URL(request.url);
  const database = await getD1();

  if (url.searchParams.get("view") === "ledger") {
    const storeId = safeText(url.searchParams.get("storeId"), 80);
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.trunc(requestedLimit), LEDGER_MAX_LIMIT)
      : LEDGER_DEFAULT_LIMIT;
    try {
      const where = storeId ? "WHERE store_id=?1" : "";
      const bindings = storeId ? [storeId, limit] : [limit];
      const result = await database
        .prepare(
          `SELECT id, store_id AS storeId, store_name AS storeName,
                  adjustment_date AS adjustmentDate, amount_cents AS amountCents,
                  reason, canceled, canceled_by_name AS canceledByName, canceled_at AS canceledAt,
                  created_by_name AS createdByName, created_at AS createdAt
           FROM commercial_gd_balance_adjustments ${where}
           ORDER BY created_at DESC
           LIMIT ?${bindings.length}`,
        )
        .bind(...bindings)
        .all();
      return jsonResponse({ rows: result.results ?? [] });
    } catch (error) {
      console.error("Não foi possível carregar o ledger do Controle GD.", error);
      return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O HISTÓRICO DE AJUSTES." }, 500);
    }
  }

  try {
    const today = todayDate();
    const monthPrefix = today.slice(0, 7);
    const last7Dates = buildLastNDates(today, 7);
    const windowStart = monthPrefix + "-01" < last7Dates[0] ? monthPrefix + "-01" : last7Dates[0];

    const [companies, balanceResult, recentResult] = await Promise.all([
      loadCompanies(database),
      database
        .prepare(
          `SELECT store_id AS storeId, SUM(amount_cents) AS balanceCents
           FROM commercial_gd_balance_adjustments
           WHERE canceled=0
           GROUP BY store_id`,
        )
        .all<{ storeId: string; balanceCents: number }>(),
      database
        .prepare(
          `SELECT store_id AS storeId, adjustment_date AS adjustmentDate, amount_cents AS amountCents
           FROM commercial_gd_balance_adjustments
           WHERE canceled=0 AND adjustment_date >= ?1`,
        )
        .bind(windowStart)
        .all<{ storeId: string; adjustmentDate: string; amountCents: number }>(),
    ]);

    const balanceByStore = new Map((balanceResult.results ?? []).map((row) => [row.storeId, row.balanceCents]));
    const recentByStore = new Map<string, { adjustmentDate: string; amountCents: number }[]>();
    for (const row of recentResult.results ?? []) {
      const list = recentByStore.get(row.storeId) ?? [];
      list.push({ adjustmentDate: row.adjustmentDate, amountCents: row.amountCents });
      recentByStore.set(row.storeId, list);
    }

    const stores = companies.map((company) => {
      const recent = recentByStore.get(company.id) ?? [];
      const monthAdjustments = recent.filter((row) => row.adjustmentDate.startsWith(monthPrefix));
      const balanceCents = balanceByStore.get(company.id) ?? 0;
      const monthMovementCents = monthAdjustments.reduce((sum, row) => sum + row.amountCents, 0);
      const worstNegativeAdjustmentCents = monthAdjustments.reduce(
        (worst, row) => (row.amountCents < worst ? row.amountCents : worst),
        0,
      );
      const status = classifyGdBalance(balanceCents, monthMovementCents);
      return {
        storeId: company.id,
        storeName: company.name,
        balanceCents,
        monthMovementCents,
        worstNegativeAdjustmentCents,
        last7Days: aggregateLast7Days(recent, last7Dates),
        status,
        statusLabel: GD_BALANCE_STATUS_LABELS[status],
      };
    });

    return jsonResponse({ date: today, companies, stores });
  } catch (error) {
    console.error("Não foi possível carregar o Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CONTROLE GD." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "controle_gd:manage")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR AJUSTE DE SALDO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const storeId = safeText(body.storeId, 80);
    const storeName = safeText(body.storeName, 120);
    const adjustmentDate = safeText(body.adjustmentDate, 10);
    const reason = safeText(body.reason, 300);
    const amountCents = Number(body.amountCents);

    if (!storeId) {
      return jsonResponse({ error: "LOJA INVÁLIDA." }, 400);
    }
    if (!ADJUSTMENT_DATE_PATTERN.test(adjustmentDate)) {
      return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    }
    if (!Number.isInteger(amountCents) || amountCents === 0) {
      return jsonResponse({ error: "VALOR DO AJUSTE PRECISA SER UM NÚMERO INTEIRO DIFERENTE DE ZERO." }, 400);
    }
    if (Math.abs(amountCents) > MAX_AMOUNT_CENTS) {
      return jsonResponse({ error: "VALOR FORA DO LIMITE." }, 400);
    }

    const database = await getD1();
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO commercial_gd_balance_adjustments
          (id, store_id, store_name, adjustment_date, amount_cents, reason, source,
           canceled, created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'manual', 0, ?7, ?8, CURRENT_TIMESTAMP)`,
      )
      .bind(id, storeId, storeName, adjustmentDate, amountCents, reason, actor.id, actor.displayName)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível lançar o ajuste de saldo do Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LANÇAR O AJUSTE." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "controle_gd:manage")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CANCELAR AJUSTE DE SALDO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) {
      return jsonResponse({ error: "AJUSTE INVÁLIDO." }, 400);
    }
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM commercial_gd_balance_adjustments WHERE id=?1 AND canceled=0 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "AJUSTE NÃO ENCONTRADO OU JÁ CANCELADO." }, 404);
    }
    await database
      .prepare(
        `UPDATE commercial_gd_balance_adjustments
         SET canceled=1, canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
      )
      .bind(actor.id, actor.displayName, id)
      .run();
    return jsonResponse({ canceled: true });
  } catch (error) {
    console.error("Não foi possível cancelar o ajuste de saldo do Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CANCELAR O AJUSTE." }, 500);
  }
}
