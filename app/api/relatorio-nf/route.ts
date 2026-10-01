import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { computeNfTotals, REPORT_DATE_PATTERN, type NfStoreEntry } from "../../lib/relatorio-nf";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type CompanyEntry = { id: string; name: string };

const HISTORY_DEFAULT_LIMIT = 30;
const HISTORY_MAX_LIMIT = 90;
const MAX_SALES_COUNT = 100000;
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
  return can(actor, "relatorio_nf:view") || can(actor, "relatorio_nf:manage");
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

type NfEntryRow = {
  storeId: string;
  storeName: string;
  salesCount: number;
  invoicesIssuedCount: number;
  salesAmountCents: number;
  invoicesIssuedAmountCents: number;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AO RELATÓRIO NF." }, 403);
  }

  const url = new URL(request.url);
  const database = await getD1();

  if (url.searchParams.get("view") === "history") {
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.trunc(requestedLimit), HISTORY_MAX_LIMIT)
      : HISTORY_DEFAULT_LIMIT;
    try {
      const result = await database
        .prepare(
          `SELECT report_date AS reportDate,
                  SUM(sales_count) AS totalSalesCount,
                  SUM(invoices_issued_count) AS totalInvoicesIssuedCount,
                  SUM(sales_amount_cents) AS totalSalesAmountCents,
                  SUM(invoices_issued_amount_cents) AS totalInvoicesIssuedAmountCents
           FROM commercial_nf_report_entries
           GROUP BY report_date
           ORDER BY report_date DESC
           LIMIT ?1`,
        )
        .bind(limit)
        .all<{
          reportDate: string;
          totalSalesCount: number;
          totalInvoicesIssuedCount: number;
          totalSalesAmountCents: number;
          totalInvoicesIssuedAmountCents: number;
        }>();
      const rows = (result.results ?? []).map((row) => ({
        ...row,
        pctIssued: row.totalSalesCount > 0 ? (row.totalInvoicesIssuedCount / row.totalSalesCount) * 100 : 0,
      }));
      return jsonResponse({ rows });
    } catch (error) {
      console.error("Não foi possível carregar o histórico do Relatório NF.", error);
      return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O HISTÓRICO." }, 500);
    }
  }

  const requestedDate = safeText(url.searchParams.get("date"), 10);
  const date = REPORT_DATE_PATTERN.test(requestedDate) ? requestedDate : todayDate();

  try {
    const [companies, result] = await Promise.all([
      loadCompanies(database),
      database
        .prepare(
          `SELECT store_id AS storeId, store_name AS storeName,
                  sales_count AS salesCount, invoices_issued_count AS invoicesIssuedCount,
                  sales_amount_cents AS salesAmountCents,
                  invoices_issued_amount_cents AS invoicesIssuedAmountCents
           FROM commercial_nf_report_entries WHERE report_date=?1`,
        )
        .bind(date)
        .all<NfEntryRow>(),
    ]);
    const byStoreId = new Map((result.results ?? []).map((row) => [row.storeId, row]));
    const entries: NfStoreEntry[] = companies.map((company) => {
      const row = byStoreId.get(company.id);
      return {
        storeId: company.id,
        storeName: company.name,
        salesCount: row?.salesCount ?? 0,
        invoicesIssuedCount: row?.invoicesIssuedCount ?? 0,
        salesAmountCents: row?.salesAmountCents ?? 0,
        invoicesIssuedAmountCents: row?.invoicesIssuedAmountCents ?? 0,
      };
    });
    return jsonResponse({ date, companies, entries, totals: computeNfTotals(entries) });
  } catch (error) {
    console.error("Não foi possível carregar o Relatório NF.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RELATÓRIO NF." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "relatorio_nf:manage")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O RELATÓRIO NF." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const date = safeText(body.date, 10);
    if (!REPORT_DATE_PATTERN.test(date)) {
      return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    }
    const rawEntries = Array.isArray(body.entries) ? (body.entries as JsonMap[]) : [];
    if (!rawEntries.length) {
      return jsonResponse({ error: "INFORME AO MENOS UMA LOJA." }, 400);
    }

    const entries: { storeId: string; storeName: string; salesCount: number; invoicesIssuedCount: number; salesAmountCents: number; invoicesIssuedAmountCents: number }[] = [];
    for (const raw of rawEntries) {
      const storeId = safeText(raw.storeId, 80);
      if (!storeId) {
        return jsonResponse({ error: "LOJA INVÁLIDA." }, 400);
      }
      const salesCount = Number(raw.salesCount);
      const invoicesIssuedCount = Number(raw.invoicesIssuedCount);
      const salesAmountCents = Number(raw.salesAmountCents);
      const invoicesIssuedAmountCents = Number(raw.invoicesIssuedAmountCents);
      const fields = [salesCount, invoicesIssuedCount, salesAmountCents, invoicesIssuedAmountCents];
      if (fields.some((value) => !Number.isInteger(value) || value < 0)) {
        return jsonResponse({ error: "VALORES PRECISAM SER NÚMEROS INTEIROS NÃO NEGATIVOS." }, 400);
      }
      if (salesCount > MAX_SALES_COUNT || invoicesIssuedCount > MAX_SALES_COUNT) {
        return jsonResponse({ error: "QUANTIDADE DE VENDAS/EMITIDAS FORA DO LIMITE." }, 400);
      }
      if (salesAmountCents > MAX_AMOUNT_CENTS || invoicesIssuedAmountCents > MAX_AMOUNT_CENTS) {
        return jsonResponse({ error: "VALOR FORA DO LIMITE." }, 400);
      }
      entries.push({
        storeId,
        storeName: safeText(raw.storeName, 120),
        salesCount,
        invoicesIssuedCount,
        salesAmountCents,
        invoicesIssuedAmountCents,
      });
    }

    const database = await getD1();
    const operations = entries.map((entry) =>
      database
        .prepare(
          `INSERT INTO commercial_nf_report_entries
            (id, report_date, store_id, store_name, sales_count, invoices_issued_count,
             sales_amount_cents, invoices_issued_amount_cents,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)
           ON CONFLICT (report_date, store_id) DO UPDATE SET
             store_name=?4, sales_count=?5, invoices_issued_count=?6,
             sales_amount_cents=?7, invoices_issued_amount_cents=?8,
             updated_by=?9, updated_by_name=?10, updated_at=CURRENT_TIMESTAMP`,
        )
        .bind(
          crypto.randomUUID(),
          date,
          entry.storeId,
          entry.storeName,
          entry.salesCount,
          entry.invoicesIssuedCount,
          entry.salesAmountCents,
          entry.invoicesIssuedAmountCents,
          actor.id,
          actor.displayName,
        ),
    );
    await database.batch(operations);
    return jsonResponse({ saved: true, date });
  } catch (error) {
    console.error("Não foi possível salvar o Relatório NF.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O RELATÓRIO NF." }, 500);
  }
}
