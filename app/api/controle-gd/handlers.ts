// Controle de Gorduras: o mesmo módulo serve o Comercial (/api/controle-gd,
// permissões controle_gd:*) e a Assistência (/api/gorduras-assistencia,
// permissões gorduras_assistencia:*). Os dados ficam nas mesmas tabelas,
// separados pela coluna module (valor fixo do código, nunca do usuário).
import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import {
  ADJUSTMENT_DATE_PATTERN,
  aggregateLast7Days,
  buildLastNDates,
  classifyGdBalance,
  GD_BALANCE_STATUS_LABELS,
  MONTH_PATTERN,
  openingBalanceCents,
} from "../../lib/controle-gd";
import { canActOnStore, hasCompany, NO_COMPANY_ERROR, resolveStoreScope } from "../../lib/access-scope";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type CompanyEntry = { id: string; name: string };

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

// Permissões (prefixo controle_gd ou gorduras_assistencia): :view (ver), :create (lançar gordura), :edit
// (alterar/excluir gordura) e :opening (corrigir o SALDO ANTERIOR). Loja
// vinculada só vê e mexe na própria loja; sem loja vê todas (access-scope).
export type GdConfig = { module: "comercial" | "assistencia"; prefix: "controle_gd" | "gorduras_assistencia" };
export const COMERCIAL_GD: GdConfig = { module: "comercial", prefix: "controle_gd" };
export const ASSISTENCIA_GD: GdConfig = { module: "assistencia", prefix: "gorduras_assistencia" };

function canView(actor: Identity, cfg: GdConfig) {
  return ["view", "create", "edit", "opening"].some((action) => can(actor, `${cfg.prefix}:${action}`));
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
// Assistência e Depósito são setores internos, não lojas: ficam fora dos dois
// Controles de Gorduras (mesmo critério de isNonStoreCompany em worker/index.ts).
export function isGdStore(name: string): boolean {
  const normalized = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return !(
    /\bassistencia\b/.test(normalized) || normalized.includes("assistance") ||
    /\bdeposito\b/.test(normalized) || normalized === "cd" || normalized.startsWith("cd ") ||
    normalized.includes("centro de distribuicao")
  );
}

async function loadCompanies(database: D1Database): Promise<CompanyEntry[]> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  try {
    const list = row?.value ? (JSON.parse(row.value) as CompanyEntry[]) : [];
    return Array.isArray(list)
      ? list.filter((item): item is CompanyEntry => Boolean(item) && typeof item.id === "string" && isGdStore(String(item.name || "")))
      : [];
  } catch {
    return [];
  }
}


function nextMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 12 ? `${year + 1}-01` : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
}

type EntryInput = { entryDate: string; saleCode: string; sellerName: string; amountCents: number; notes: string };

function parseEntry(body: JsonMap): { error: string } | { entry: EntryInput } {
  const entry = {
    entryDate: safeText(body.entryDate, 10),
    saleCode: safeText(body.saleCode, 40),
    sellerName: safeText(body.sellerName, 80).toLocaleUpperCase("pt-BR"),
    amountCents: Number(body.amountCents),
    notes: safeText(body.notes, 1000),
  };
  if (!ADJUSTMENT_DATE_PATTERN.test(entry.entryDate)) return { error: "DATA INVÁLIDA." };
  if (!entry.saleCode) return { error: "INFORME O ID DA VENDA." };
  if (!Number.isInteger(entry.amountCents) || entry.amountCents === 0) {
    return { error: "INFORME UM VALOR DIFERENTE DE ZERO." };
  }
  if (Math.abs(entry.amountCents) > MAX_AMOUNT_CENTS) return { error: "VALOR FORA DO LIMITE." };
  return { entry };
}

function writeGuard(request: Request, permission: string, message: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!can(actor, permission)) return { error: jsonResponse({ error: message }, 403) };
  // Login com loja vinculada só VISUALIZA as gorduras da própria loja (decisão
  // do usuário, 08/10/2026): lançar, alterar, excluir e saldo anterior só sem loja.
  if (actor.role !== "admin" && hasCompany(actor.companyId)) {
    return { error: jsonResponse({ error: "LOGIN DE LOJA SÓ VISUALIZA AS GORDURAS." }, 403) };
  }
  if (!sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

export async function GET(request: Request, cfg: GdConfig) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor, cfg)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AO CONTROLE GD." }, 403);
  }
  const scope = resolveStoreScope(actor, `${cfg.prefix}:view`);
  if (scope.blocked) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  const url = new URL(request.url);
  const database = await getD1();

  // Sugestões de VENDEDOR: funcionários ativos da loja (aceita texto livre no front).
  if (url.searchParams.get("view") === "sellers") {
    const storeId = safeText(url.searchParams.get("storeId"), 80);
    if (!storeId || !canActOnStore(actor, `${cfg.prefix}:view`, storeId)) return jsonResponse({ sellers: [] });
    try {
      const result = await database
        .prepare("SELECT full_name AS name FROM hr_employees WHERE company_id=?1 AND status='active' ORDER BY full_name")
        .bind(storeId)
        .all<{ name: string }>();
      const sellers = (result.results ?? []).map((row) => String(row.name || "").toLocaleUpperCase("pt-BR"));
      return jsonResponse({ sellers });
    } catch (error) {
      console.error("Não foi possível carregar os vendedores do Controle GD.", error);
      return jsonResponse({ sellers: [] });
    }
  }

  try {
    const today = todayDate();
    const requestedMonth = safeText(url.searchParams.get("month"), 7);
    const month = MONTH_PATTERN.test(requestedMonth) ? requestedMonth : today.slice(0, 7);
    const monthStart = month + "-01";
    const monthEnd = nextMonth(month) + "-01";
    const last7Dates = buildLastNDates(today, 7);

    // Loja vinculada: tudo filtrado na própria loja já no SQL (?9 vira o
    // próximo parâmetro livre).
    const storeSql = `${scope.allStores ? "" : " AND store_id=?9"} AND module='${cfg.module}'`;
    const bindStore = <T,>(sqlText: string, values: unknown[]) =>
      scope.allStores
        ? database.prepare(sqlText).bind(...values).all<T>()
        : database.prepare(sqlText.replace("?9", `?${values.length + 1}`)).bind(...values, actor.companyId).all<T>();

    const [allCompanies, sumsResult, overridesResult, recentResult, entriesResult] = await Promise.all([
      loadCompanies(database),
      bindStore<{ storeId: string; month: string; amountCents: number }>(
        `SELECT store_id AS storeId, substr(adjustment_date, 1, 7) AS month, SUM(amount_cents) AS amountCents
         FROM commercial_gd_balance_adjustments
         WHERE canceled=0 AND adjustment_date < ?1${storeSql}
         GROUP BY store_id, substr(adjustment_date, 1, 7)`,
        [monthEnd],
      ),
      bindStore<{ storeId: string; month: string; balanceCents: number }>(
        `SELECT store_id AS storeId, month, balance_cents AS balanceCents
         FROM commercial_gd_opening_balances WHERE month <= ?1${storeSql}`,
        [month],
      ),
      bindStore<{ storeId: string; adjustmentDate: string; amountCents: number }>(
        `SELECT store_id AS storeId, adjustment_date AS adjustmentDate, amount_cents AS amountCents
         FROM commercial_gd_balance_adjustments
         WHERE canceled=0 AND adjustment_date >= ?1${storeSql}`,
        [last7Dates[0]],
      ),
      bindStore<Record<string, unknown>>(
        `SELECT id, store_id AS storeId, store_name AS storeName, adjustment_date AS entryDate,
                sale_code AS saleCode, seller_name AS sellerName, amount_cents AS amountCents, reason AS notes,
                created_by_name AS createdByName, created_at AS createdAt,
                updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM commercial_gd_balance_adjustments
         WHERE canceled=0 AND adjustment_date >= ?1 AND adjustment_date < ?2${storeSql}
         ORDER BY adjustment_date DESC, created_at DESC`,
        [monthStart, monthEnd],
      ),
    ]);

    const companies = scope.allStores ? allCompanies : allCompanies.filter((company) => company.id === actor.companyId);
    const group = <T extends { storeId: string }>(rows: T[] | undefined) => {
      const map = new Map<string, T[]>();
      for (const row of rows ?? []) map.set(row.storeId, [...(map.get(row.storeId) ?? []), row]);
      return map;
    };
    const sumsByStore = group(sumsResult.results);
    const overridesByStore = group(overridesResult.results);
    const recentByStore = group(recentResult.results);
    const entries = (entriesResult.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
    const entriesByStore = group(entries as { storeId: string; amountCents: number }[]);

    const stores = companies.map((company) => {
      const sums = (sumsByStore.get(company.id) ?? []).map((row) => ({ month: row.month, amountCents: Number(row.amountCents) }));
      const overrides = (overridesByStore.get(company.id) ?? []).map((row) => ({ month: row.month, balanceCents: Number(row.balanceCents) }));
      const monthEntries = entriesByStore.get(company.id) ?? [];
      const openingCents = openingBalanceCents(sums, overrides, month);
      const positiveCents = monthEntries.reduce((sum, row) => (row.amountCents > 0 ? sum + row.amountCents : sum), 0);
      const negativeCents = monthEntries.reduce((sum, row) => (row.amountCents < 0 ? sum + row.amountCents : sum), 0);
      const monthMovementCents = positiveCents + negativeCents;
      const balanceCents = openingCents + monthMovementCents;
      const worstNegativeAdjustmentCents = monthEntries.reduce((worst, row) => Math.min(worst, row.amountCents), 0);
      const recent = (recentByStore.get(company.id) ?? []).map((row) => ({ adjustmentDate: row.adjustmentDate, amountCents: Number(row.amountCents) }));
      const status = classifyGdBalance(balanceCents, monthMovementCents);
      return {
        storeId: company.id,
        storeName: company.name,
        openingCents,
        openingManual: overrides.some((row) => row.month === month),
        positiveCents,
        negativeCents,
        balanceCents,
        monthMovementCents,
        worstNegativeAdjustmentCents,
        last7Days: aggregateLast7Days(recent, last7Dates),
        status,
        statusLabel: GD_BALANCE_STATUS_LABELS[status],
      };
    });

    return jsonResponse({ date: today, month, allStores: scope.allStores, companies, stores, entries });
  } catch (error) {
    console.error("Não foi possível carregar o Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CONTROLE GD." }, 500);
  }
}

// Lança uma gordura (positiva ou negativa) de uma venda.
export async function POST(request: Request, cfg: GdConfig) {
  const guard = writeGuard(request, `${cfg.prefix}:create`, "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR GORDURA.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json()) as JsonMap;
    const storeId = safeText(body.storeId, 80);
    const parsed = parseEntry(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const database = await getD1();
    const store = (await loadCompanies(database)).find((company) => company.id === storeId);
    if (!store || !canActOnStore(actor, `${cfg.prefix}:create`, storeId)) {
      return jsonResponse({ error: "LOJA INVÁLIDA." }, 400);
    }
    const { entry } = parsed;
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO commercial_gd_balance_adjustments
          (id, store_id, store_name, adjustment_date, amount_cents, sale_code, seller_name, reason, source,
           canceled, created_by, created_by_name, created_at, module)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'manual', 0, ?9, ?10, CURRENT_TIMESTAMP, ?11)`,
      )
      .bind(id, storeId, store.name, entry.entryDate, entry.amountCents, entry.saleCode, entry.sellerName, entry.notes,
        actor.id, actor.displayName, cfg.module)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível lançar a gordura do Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LANÇAR A GORDURA." }, 500);
  }
}

async function findEntry(database: D1Database, actor: Identity, id: string, cfg: GdConfig) {
  const row = id
    ? await database
      .prepare("SELECT id, store_id AS storeId FROM commercial_gd_balance_adjustments WHERE id=?1 AND canceled=0 AND module=?2")
      .bind(id, cfg.module)
      .first<{ id: string; storeId: string }>()
    : null;
  // Fora do escopo da loja: mesmo 404 de "não encontrado".
  return row && canActOnStore(actor, `${cfg.prefix}:edit`, row.storeId) ? row : null;
}

// Altera uma gordura já lançada (a loja não muda).
export async function PATCH(request: Request, cfg: GdConfig) {
  const guard = writeGuard(request, `${cfg.prefix}:edit`, "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR GORDURA.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json()) as JsonMap;
    const parsed = parseEntry(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const database = await getD1();
    const row = await findEntry(database, actor, safeText(body.id, 80), cfg);
    if (!row) return jsonResponse({ error: "GORDURA NÃO ENCONTRADA." }, 404);
    const { entry } = parsed;
    await database
      .prepare(
        `UPDATE commercial_gd_balance_adjustments
         SET adjustment_date=?1, amount_cents=?2, sale_code=?3, seller_name=?4, reason=?5,
             updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP
         WHERE id=?8`,
      )
      .bind(entry.entryDate, entry.amountCents, entry.saleCode, entry.sellerName, entry.notes,
        actor.id, actor.displayName, row.id)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível alterar a gordura do Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ALTERAR A GORDURA." }, 500);
  }
}

// Exclui uma gordura (fica marcada como cancelada no banco, fora dos totais).
export async function DELETE(request: Request, cfg: GdConfig) {
  const guard = writeGuard(request, `${cfg.prefix}:edit`, "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR GORDURA.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const row = await findEntry(database, actor, safeText(body.id, 80), cfg);
    if (!row) return jsonResponse({ error: "GORDURA NÃO ENCONTRADA." }, 404);
    await database
      .prepare(
        `UPDATE commercial_gd_balance_adjustments
         SET canceled=1, canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
      )
      .bind(actor.id, actor.displayName, row.id)
      .run();
    return jsonResponse({ canceled: true });
  } catch (error) {
    console.error("Não foi possível excluir a gordura do Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A GORDURA." }, 500);
  }
}

// SALDO ANTERIOR corrigido à mão: {storeId, month, balanceCents}; balanceCents
// null volta ao automático (fechamento do mês anterior).
export async function PUT(request: Request, cfg: GdConfig) {
  const guard = writeGuard(request, `${cfg.prefix}:opening`, "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O SALDO ANTERIOR.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json()) as JsonMap;
    const storeId = safeText(body.storeId, 80);
    const month = safeText(body.month, 7);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
    const database = await getD1();
    const store = (await loadCompanies(database)).find((company) => company.id === storeId);
    if (!store || !canActOnStore(actor, `${cfg.prefix}:opening`, storeId)) {
      return jsonResponse({ error: "LOJA INVÁLIDA." }, 400);
    }
    if (body.balanceCents === null) {
      await database
        .prepare("DELETE FROM commercial_gd_opening_balances WHERE store_id=?1 AND month=?2 AND module=?3")
        .bind(storeId, month, cfg.module)
        .run();
      return jsonResponse({ updated: true, automatic: true });
    }
    const balanceCents = Number(body.balanceCents);
    if (!Number.isInteger(balanceCents) || Math.abs(balanceCents) > MAX_AMOUNT_CENTS) {
      return jsonResponse({ error: "VALOR INVÁLIDO." }, 400);
    }
    await database
      .prepare(
        `INSERT INTO commercial_gd_opening_balances (id, store_id, month, balance_cents, updated_by, updated_by_name, updated_at, module)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, ?7)
         ON CONFLICT (module, store_id, month) DO UPDATE SET balance_cents=excluded.balance_cents,
           updated_by=excluded.updated_by, updated_by_name=excluded.updated_by_name, updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(`${cfg.module}:${storeId}:${month}`, storeId, month, balanceCents, actor.id, actor.displayName, cfg.module)
      .run();
    return jsonResponse({ updated: true, automatic: false });
  } catch (error) {
    console.error("Não foi possível alterar o saldo anterior do Controle GD.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ALTERAR O SALDO ANTERIOR." }, 500);
  }
}
