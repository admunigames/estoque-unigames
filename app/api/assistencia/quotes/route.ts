import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany } from "../../../lib/access-scope";
import { isDateOnly, isUniqueViolation, parseQuote, upper } from "../../../lib/assistencia";
import {
  canManage,
  companyName,
  FORBIDDEN,
  identity,
  itemStatements,
  jsonResponse,
  normalizeQuote,
  osConflictMessage,
  osTaken,
  QUOTE_SELECT,
  safeText,
  sameOrigin,
  type JsonMap,
  type QuoteRow,
} from "../shared";

type DeviceRow = { quoteId: string; equipmentIndex: number; device: string };

// Histórico de TODAS as lojas (sem escopo pelo login): busca por cliente ou
// nº da OS, filtro de loja e de período (data de entrada).
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);

  try {
    const url = new URL(request.url);
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      params.push(value);
      conditions.push(condition.replaceAll("?", `?${params.length}`));
    };
    const search = upper(safeText(url.searchParams.get("q"), 80)).replace(/[\\%_]/g, (char) => `\\${char}`);
    if (search) add("(client_name LIKE ? ESCAPE '\\' OR os_number LIKE ? ESCAPE '\\')", `%${search}%`);
    const company = safeText(url.searchParams.get("companyId"), 80);
    if (hasCompany(company)) add("company_id=?", company);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (isDateOnly(from)) add("entry_date>=?", from);
    if (isDateOnly(to)) add("entry_date<=?", to);
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

    const database = await getD1();
    const quotes = await database
      .prepare(`${QUOTE_SELECT}${where} ORDER BY entry_date DESC, created_at DESC LIMIT 500`)
      .bind(...params)
      .all<QuoteRow>();
    const rows = quotes.results ?? [];
    const devices = rows.length
      ? await database
          .prepare(
            `SELECT quote_id AS quoteId, equipment_index AS equipmentIndex, device
             FROM assist_quote_items
             WHERE quote_id IN (SELECT id FROM assist_quotes${where})
             ORDER BY quote_id, equipment_index, sort_order`,
          )
          .bind(...params)
          .all<DeviceRow>()
      : { results: [] as DeviceRow[] };
    const byQuote = new Map<string, Map<number, string>>();
    for (const item of devices.results ?? []) {
      const list = byQuote.get(item.quoteId) || new Map<number, string>();
      const index = Number(item.equipmentIndex) || 0;
      if (!list.has(index)) list.set(index, String(item.device || ""));
      byQuote.set(item.quoteId, list);
    }
    return jsonResponse({
      quotes: rows.map((row) => {
        const quote: Partial<QuoteRow> = normalizeQuote(row);
        delete quote.observations;
        return { ...quote, devices: Array.from((byQuote.get(row.id) || new Map<number, string>()).values()) };
      }),
    });
  } catch (error) {
    console.error("Não foi possível carregar os orçamentos da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS ORÇAMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  let osNumber = "";
  try {
    const body = (await request.json()) as JsonMap;
    const parsed = parseQuote(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const quote = parsed.quote;
    osNumber = quote.osNumber;

    const database = await getD1();
    const resolvedCompanyName = await companyName(database, quote.companyId);
    if (!resolvedCompanyName) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    if (await osTaken(database, quote.osNumber)) {
      return jsonResponse({ error: osConflictMessage(quote.osNumber) }, 409);
    }

    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `INSERT INTO assist_quotes
            (id, os_number, company_id, company_name, entry_date, client_name, client_cpf, client_phone,
             client_address, observations, extra_notes, total_cents, created_by, created_by_name, created_at,
             updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?13, ?14, ?15)`,
        )
        .bind(
          id,
          quote.osNumber,
          quote.companyId,
          resolvedCompanyName,
          quote.entryDate,
          quote.clientName,
          quote.clientCpf,
          quote.clientPhone,
          quote.clientAddress,
          JSON.stringify(quote.observations),
          quote.extraNotes,
          quote.totalCents,
          actor.id,
          actor.displayName,
          at,
        ),
      ...itemStatements(database, id, quote),
    ]);
    return jsonResponse({ created: true, id, totalCents: quote.totalCents }, 201);
  } catch (error) {
    // Duas pessoas salvando a mesma OS ao mesmo tempo: o índice único segura.
    if (osNumber && isUniqueViolation(error)) {
      return jsonResponse({ error: osConflictMessage(osNumber) }, 409);
    }
    console.error("Não foi possível salvar o orçamento da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O ORÇAMENTO." }, 500);
  }
}
