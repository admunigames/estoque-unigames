import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canSeeAllStores, hasCompany } from "../../lib/access-scope";
import { recifeDate } from "../../lib/ordens-servico";
import {
  CONTACT_RESULTS, DEFAULT_SETTINGS, matchStore, parsePdvReport, shiftDate,
  type ContactResult, type FidelizaSettings,
} from "../../lib/fideliza";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";
import { loadStores } from "../inventario/shared";

// Comercial > FIDELIZA (CRM de recompra). Permissões fideliza:*:
//   view       clientes, recorrência, inativos e agenda da própria loja
//   contact    registrar contato / resultado / retorno agendado
//   import     subir o Relatório de PDV (ADM responsável)
//   all_stores ver todas as lojas (só login SEM loja — access-scope.ts)
//   export     baixar CSV de clientes/contatos (POST → fica na auditoria)
//   manage     mensagem do WhatsApp, histórico, inatividade
// Login com loja fica SEMPRE na própria loja. Loja de outro escopo responde
// o mesmo 404 de "não encontrada".
//   GET                                     → {can, stores, settings, results, imports}
//   GET ?view=clients&companyId&segment&q   → {summary, clients, truncated}
//   GET ?view=client&companyId&key          → {sales, contacts}
//   GET ?view=agenda&companyId              → {pending, recent, today, reactivatedMonth}
//   GET ?view=overview                      → {stores (do escopo), podium (todas, só contagens)}
//   POST {action:"import", companyId, fileName, text, preview}
//   POST {action:"contact", companyId, customerKey, result, note, scheduledFor}
//   POST {action:"export", kind:"clientes"|"contatos", companyId ('' = todas do escopo), segment, q, from, to} → CSV
//   PUT  {message, inactiveDays, historyMonths}   (manage)

type Actor = ReturnType<typeof identity>;
type Database = Awaited<ReturnType<typeof getD1>>;
type Store = { id: string; name: string };

const ACTIONS = ["view", "contact", "import", "all_stores", "export", "manage"] as const;
const SETTINGS_KEY = "fideliza_settings";
const NOT_FOUND = "LOJA NÃO ENCONTRADA.";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_LIMIT = 300;
const INSERT_CHUNK = 200;

const can = (actor: Actor, action: string) => actor.role === "admin" || actor.permissions.includes(`fideliza:${action}`);

function guard(request: Request, action: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  const allowed = action === "view" ? ACTIONS.some((item) => can(actor, item)) : can(actor, action);
  if (!allowed) return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ESTA AÇÃO DO FIDELIZA." }, 403) };
  if (request.method !== "GET" && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

/** Lojas que o login alcança: com loja → só a própria; sem loja → todas se tiver `permission`. */
function storesFor(actor: Actor, stores: Store[], permission: string) {
  if (canSeeAllStores(actor, permission)) return stores;
  return hasCompany(actor.companyId) ? stores.filter((store) => store.id === actor.companyId) : [];
}

const viewStores = (actor: Actor, stores: Store[]) => storesFor(actor, stores, "fideliza:all_stores");

async function loadSettings(database: Database): Promise<FidelizaSettings> {
  const row = await database.prepare("SELECT value_json AS value FROM shared_state WHERE state_key=?1").bind(SETTINGS_KEY).first<{ value: string }>();
  try {
    return { ...DEFAULT_SETTINGS, ...(row?.value ? JSON.parse(row.value) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const payload = await request.json().catch(() => null);
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

const storeName = (store: Store) => String(store.name).toLocaleUpperCase("pt-BR");
const placeholders = (count: number, from = 1) => Array.from({ length: count }, (_, index) => `?${index + from}`).join(",");

type ClientRow = { companyId: string; key: string; name: string; purchases: number; firstDate: string; lastDate: string; totalCents: number };

// Um cliente por loja + telefone. Os aliases camelCase são referenciados
// citados ("lastDate") fora da subconsulta — no Postgres o adaptador cita o
// AS, e a referência sem aspas viraria minúscula.
function groupedClients(ids: string[]) {
  return `SELECT company_id AS companyId, customer_key AS key, max(customer_name) AS name, count(DISTINCT sale_date) AS purchases,
    min(sale_date) AS firstDate, max(sale_date) AS lastDate, sum(total_cents) AS totalCents
    FROM fideliza_sales WHERE company_id IN (${placeholders(ids.length)}) GROUP BY company_id, customer_key`;
}

/** Lista filtrada (segmento + busca por nome/telefone), parâmetros já na ordem. */
function clientFilter(ids: string[], segment: string, rawQuery: string | null, cutoff: string) {
  const params: unknown[] = [...ids];
  const param = (value: unknown) => `?${params.push(value)}`;
  const query = safeText(rawQuery, 60).toLocaleUpperCase("pt-BR");
  const digits = query.replace(/\D/g, "");
  const where: string[] = [];
  if (segment === "recorrentes") where.push("purchases >= 2");
  if (segment === "unica") where.push("purchases = 1");
  if (segment === "inativos") where.push(`"lastDate" < ${param(cutoff)}`);
  if (query) where.push(digits.length >= 4 ? `(name LIKE ${param(`%${query}%`)} OR key LIKE ${param(`%${digits}%`)})` : `name LIKE ${param(`%${query}%`)}`);
  const order = segment === "recorrentes" ? `purchases DESC, "lastDate" DESC` : `"lastDate" DESC`;
  return { sql: `SELECT * FROM (${groupedClients(ids)}) AS g WHERE ${where.join(" AND ") || "1=1"} ORDER BY ${order}, key`, params };
}

async function inactiveCutoff(database: Database, today: string) {
  const settings = await loadSettings(database);
  return shiftDate(today, { days: Number(settings.inactiveDays) || DEFAULT_SETTINGS.inactiveDays });
}

/**
 * Visão Geral: indicadores das lojas que o login alcança (loja → só a própria)
 * e o pódio do dia de TODAS as lojas, só com contagens (sem dado de cliente).
 */
async function overview(actor: Actor, database: Database, allStores: Store[], today: string) {
  const stores = viewStores(actor, allStores);
  const ids = stores.map((store) => store.id);
  const cutoff = await inactiveCutoff(database, today);
  const month = today.slice(0, 7);
  const perStore = ids.length
    ? (await database
      .prepare(`SELECT "companyId", count(*) AS clients, sum(CASE WHEN purchases >= 2 THEN 1 ELSE 0 END) AS recurring,
        sum(CASE WHEN "lastDate" < ?${ids.length + 1} THEN 1 ELSE 0 END) AS inactive
        FROM (${groupedClients(ids)}) AS g GROUP BY "companyId"`)
      .bind(...ids, cutoff)
      .all<{ companyId: string; clients: number; recurring: number; inactive: number }>()).results
    : [];
  const imports = ids.length
    ? (await database
      .prepare(`SELECT company_id AS companyId, max(period_end) AS lastPeriod FROM fideliza_imports
        WHERE company_id IN (${placeholders(ids.length)}) GROUP BY company_id`)
      .bind(...ids)
      .all<{ companyId: string; lastPeriod: string }>()).results
    : [];
  // Contatos do mês de todas as lojas (o fuso de Recife decide o dia).
  const { results: contacts } = await database
    .prepare("SELECT company_id AS companyId, customer_key AS key, result, created_at AS createdAt FROM fideliza_contacts WHERE deleted=0 AND created_at >= ?1")
    .bind(shiftDate(`${month}-01`, { days: 1 }))
    .all<{ companyId: string; key: string; result: string; createdAt: string }>();
  const tally = new Map<string, { today: number; month: number; reactivatedToday: number; reactivatedMonth: number; customers: Set<string> }>();
  for (const contact of contacts) {
    const day = recifeDate(contact.createdAt);
    if (!day.startsWith(month)) continue;
    const entry = tally.get(contact.companyId) || { today: 0, month: 0, reactivatedToday: 0, reactivatedMonth: 0, customers: new Set<string>() };
    const reactivated = contact.result === "cliente_reativado";
    entry.month += 1;
    entry.customers.add(contact.key);
    if (reactivated) entry.reactivatedMonth += 1;
    if (day === today) {
      entry.today += 1;
      if (reactivated) entry.reactivatedToday += 1;
    }
    tally.set(contact.companyId, entry);
  }
  const counts = (id: string) => tally.get(id);
  return jsonResponse({
    cutoff,
    stores: stores.map((store) => {
      const row = perStore.find((item) => item.companyId === store.id);
      const entry = counts(store.id);
      return {
        id: store.id, name: storeName(store),
        clients: Number(row?.clients) || 0, recurring: Number(row?.recurring) || 0, inactive: Number(row?.inactive) || 0,
        contactsToday: entry?.today || 0, contactsMonth: entry?.month || 0, contactedCustomersMonth: entry?.customers.size || 0,
        reactivatedMonth: entry?.reactivatedMonth || 0,
        lastPeriod: imports.find((item) => item.companyId === store.id)?.lastPeriod || "",
      };
    }),
    podium: allStores
      .map((store) => ({ name: storeName(store), contacts: counts(store.id)?.today || 0, reactivated: counts(store.id)?.reactivatedToday || 0 }))
      .sort((a, b) => b.reactivated - a.reactivated || b.contacts - a.contacts || a.name.localeCompare(b.name)),
  });
}

const RECIFE_DATE_TIME = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Recife", dateStyle: "short", timeStyle: "short" });
const brDate = (iso: string) => (iso ? iso.split("-").reverse().join("/") : "");
const phone = (key: string) => (key.length === 11 ? `(${key.slice(0, 2)}) ${key.slice(2, 7)}-${key.slice(7)}` : `(${key.slice(0, 2)}) ${key.slice(2, 6)}-${key.slice(6)}`);
/** Célula CSV (;) — sempre entre aspas; fórmula (= + - @) vira texto. */
const cell = (value: unknown) => `"${String(value ?? "").replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
const csvLine = (values: unknown[]) => values.map(cell).join(";");

/**
 * EXPORTAR (dado pessoal): CSV de clientes ou de contatos de uma loja ou de
 * todas as que o login alcança. É POST de propósito: o Worker registra na
 * auditoria quem baixou e o filtro (campo "description" do pedido).
 */
async function exportCsv(actor: Actor, database: Database, payload: Record<string, unknown>) {
  const stores = viewStores(actor, await loadStores(database));
  const chosen = safeText(payload.companyId, 80);
  const selected = chosen ? stores.filter((store) => store.id === chosen) : stores;
  if (!selected.length) return jsonResponse({ error: NOT_FOUND }, 404);
  const ids = selected.map((store) => store.id);
  const names = new Map(selected.map((store) => [store.id, storeName(store)]));
  const today = recifeDate();
  const lines: string[] = [];
  let fileName: string;

  if (payload.kind === "contatos") {
    const from = safeText(payload.from, 10);
    const to = safeText(payload.to, 10);
    if (!DATE.test(from) || !DATE.test(to) || from > to) return jsonResponse({ error: "INFORME O PERÍODO DOS CONTATOS." }, 400);
    const { results } = await database
      .prepare(`SELECT company_id AS companyId, customer_key AS key, customer_name AS name, result, scheduled_for AS scheduledFor, note,
        created_by_name AS createdByName, created_at AS createdAt FROM fideliza_contacts
        WHERE deleted=0 AND company_id IN (${placeholders(ids.length)}) AND created_at >= ?${ids.length + 1} AND created_at < ?${ids.length + 2}
        ORDER BY created_at`)
      .bind(...ids, shiftDate(from, { days: 1 }), shiftDate(to, { days: -2 }))
      .all<{ companyId: string; key: string; name: string; result: ContactResult; scheduledFor: string; note: string; createdByName: string; createdAt: string }>();
    lines.push(csvLine(["DATA", "LOJA", "CLIENTE", "TELEFONE", "RESULTADO", "RETORNO", "OBSERVAÇÃO", "POR"]));
    for (const row of results) {
      const day = recifeDate(row.createdAt);
      if (day < from || day > to) continue;
      lines.push(csvLine([RECIFE_DATE_TIME.format(new Date(row.createdAt)), names.get(row.companyId), row.name, phone(row.key),
        CONTACT_RESULTS[row.result] || row.result, brDate(row.scheduledFor), row.note, row.createdByName]));
    }
    fileName = `fideliza-contatos-${from}-a-${to}.csv`;
  } else {
    const cutoff = await inactiveCutoff(database, today);
    const filter = clientFilter(ids, safeText(payload.segment, 20), typeof payload.q === "string" ? payload.q : "", cutoff);
    const { results } = await database.prepare(filter.sql).bind(...filter.params).all<ClientRow>();
    const { results: contacts } = await database
      .prepare(`SELECT company_id AS companyId, customer_key AS key, result, created_at AS createdAt FROM fideliza_contacts
        WHERE deleted=0 AND company_id IN (${placeholders(ids.length)}) ORDER BY created_at`)
      .bind(...ids)
      .all<{ companyId: string; key: string; result: ContactResult; createdAt: string }>();
    const last = new Map(contacts.map((contact) => [`${contact.companyId}:${contact.key}`, contact]));
    lines.push(csvLine(["LOJA", "CLIENTE", "TELEFONE", "COMPRAS", "PRIMEIRA COMPRA", "ÚLTIMA COMPRA", "TOTAL (R$)", "SITUAÇÃO", "ÚLTIMO CONTATO", "DATA DO ÚLTIMO CONTATO"]));
    for (const row of results) {
      const contact = last.get(`${row.companyId}:${row.key}`);
      lines.push(csvLine([names.get(row.companyId), row.name, phone(row.key), Number(row.purchases), brDate(row.firstDate), brDate(row.lastDate),
        (Number(row.totalCents) / 100).toFixed(2).replace(".", ","), row.lastDate < cutoff ? "INATIVO" : Number(row.purchases) >= 2 ? "RECORRENTE" : "COMPRA ÚNICA",
        contact ? CONTACT_RESULTS[contact.result] || contact.result : "", contact ? RECIFE_DATE_TIME.format(new Date(contact.createdAt)) : ""]));
    }
    fileName = `fideliza-clientes-${today}.csv`;
  }
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  const checked = guard(request, "view");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "";
  const database = await getD1();
  const allStores = await loadStores(database);

  if (!view) {
    const stores = viewStores(actor, allStores);
    const importStores = storesFor(actor, allStores, "fideliza:import");
    const ids = importStores.map((store) => store.id);
    const imports = can(actor, "import") && ids.length
      ? (await database
        .prepare(`SELECT id, company_name AS companyName, file_name AS fileName, period_start AS periodStart, period_end AS periodEnd,
          sales_total AS salesTotal, sales_kept AS salesKept, sales_new AS salesNew, sales_purged AS salesPurged,
          created_by_name AS createdByName, created_at AS createdAt
          FROM fideliza_imports WHERE company_id IN (${ids.map((_, index) => `?${index + 1}`).join(",")})
          ORDER BY created_at DESC LIMIT 50`)
        .bind(...ids)
        .all()).results
      : [];
    return jsonResponse({
      can: Object.fromEntries(ACTIONS.map((action) => [action, can(actor, action)])),
      stores: stores.map((store) => ({ id: store.id, name: storeName(store) })),
      importStores: can(actor, "import") ? importStores.map((store) => ({ id: store.id, name: storeName(store) })) : [],
      settings: await loadSettings(database),
      results: CONTACT_RESULTS,
      imports,
      today: recifeDate(),
    });
  }

  const today = recifeDate();
  if (view === "overview") return overview(actor, database, allStores, today);

  const store = viewStores(actor, allStores).find((item) => item.id === safeText(url.searchParams.get("companyId"), 80));
  if (!store) return jsonResponse({ error: NOT_FOUND }, 404);

  if (view === "clients") {
    const cutoff = await inactiveCutoff(database, today);
    const summary = await database
      .prepare(`SELECT count(*) AS clients, sum(CASE WHEN purchases >= 2 THEN 1 ELSE 0 END) AS recurring,
        sum(CASE WHEN "lastDate" < ?2 THEN 1 ELSE 0 END) AS inactive FROM (${groupedClients([store.id])}) AS g`)
      .bind(store.id, cutoff)
      .first<{ clients: number; recurring: number; inactive: number }>();
    const filter = clientFilter([store.id], url.searchParams.get("segment") || "", url.searchParams.get("q"), cutoff);
    const { results } = await database
      .prepare(`${filter.sql} LIMIT ${LIST_LIMIT + 1}`)
      .bind(...filter.params)
      .all<ClientRow>();
    const clients = results.slice(0, LIST_LIMIT);
    const keys = clients.map((client) => client.key);
    const last = new Map<string, Record<string, unknown>>();
    if (keys.length) {
      const contacts = await database
        .prepare(`SELECT customer_key AS key, result, scheduled_for AS scheduledFor, created_by_name AS createdByName, created_at AS createdAt
          FROM fideliza_contacts WHERE company_id=?1 AND deleted=0 AND customer_key IN (${keys.map((_, index) => `?${index + 2}`).join(",")})
          ORDER BY created_at`)
        .bind(store.id, ...keys)
        .all<{ key: string }>();
      for (const contact of contacts.results) last.set(contact.key, contact);
    }
    return jsonResponse({
      summary: { clients: Number(summary?.clients) || 0, recurring: Number(summary?.recurring) || 0, inactive: Number(summary?.inactive) || 0 },
      cutoff,
      clients: clients.map((client) => ({ ...client, purchases: Number(client.purchases), totalCents: Number(client.totalCents), lastContact: last.get(client.key) || null })),
      truncated: results.length > LIST_LIMIT,
    });
  }

  if (view === "client") {
    const key = safeText(url.searchParams.get("key"), 20);
    const [sales, contacts] = [
      await database
        .prepare(`SELECT sale_no AS saleNo, sale_date AS saleDate, customer_name AS customerName, seller, payment, total_cents AS totalCents, items_json AS itemsJson
          FROM fideliza_sales WHERE company_id=?1 AND customer_key=?2 ORDER BY sale_date DESC, sale_no DESC LIMIT 200`)
        .bind(store.id, key)
        .all<{ itemsJson: string }>(),
      await database
        .prepare(`SELECT id, result, note, scheduled_for AS scheduledFor, created_by_name AS createdByName, created_at AS createdAt
          FROM fideliza_contacts WHERE company_id=?1 AND customer_key=?2 AND deleted=0 ORDER BY created_at DESC LIMIT 200`)
        .bind(store.id, key)
        .all(),
    ];
    if (!sales.results.length) return jsonResponse({ error: "CLIENTE NÃO ENCONTRADO." }, 404);
    return jsonResponse({
      sales: sales.results.map(({ itemsJson, ...sale }) => ({ ...sale, items: JSON.parse(itemsJson || "[]") })),
      contacts: contacts.results,
    });
  }

  if (view === "agenda") {
    const since = shiftDate(today, { days: 180 });
    const { results } = await database
      .prepare(`SELECT id, customer_key AS key, customer_name AS customerName, result, note, scheduled_for AS scheduledFor,
        created_by_name AS createdByName, created_at AS createdAt
        FROM fideliza_contacts WHERE company_id=?1 AND deleted=0 AND created_at >= ?2 ORDER BY created_at`)
      .bind(store.id, since)
      .all<{ key: string; result: string; createdAt: string; scheduledFor: string }>();
    const latest = new Map<string, (typeof results)[number]>();
    for (const contact of results) latest.set(contact.key, contact);
    const pending = [...latest.values()]
      .filter((contact) => contact.result === "retorno_agendado" && contact.scheduledFor)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    const month = today.slice(0, 7);
    return jsonResponse({
      pending,
      recent: results.slice(-100).reverse(),
      today: results.filter((contact) => recifeDate(contact.createdAt) === today).length,
      reactivatedMonth: results.filter((contact) => contact.result === "cliente_reativado" && recifeDate(contact.createdAt).startsWith(month)).length,
    });
  }

  return jsonResponse({ error: "CONSULTA INVÁLIDA." }, 400);
}

async function importReport(actor: Actor, database: Database, payload: Record<string, unknown>) {
  const stores = storesFor(actor, await loadStores(database), "fideliza:import");
  const text = typeof payload.text === "string" ? payload.text : "";
  if (!text) return jsonResponse({ error: "SELECIONE O RELATÓRIO DE PDV (.XLS)." }, 400);
  const report = parsePdvReport(text);
  if (!report.rows) return jsonResponse({ error: "O ARQUIVO NÃO PARECE UM RELATÓRIO DE PDV (NENHUMA VENDA ENCONTRADA)." }, 400);
  const detected = matchStore(report.storeLabel, stores);
  // Sem loja escolhida, vale a do cabeçalho; o ADM confere na prévia e pode trocar.
  const chosen = safeText(payload.companyId, 80);
  const store = chosen ? stores.find((item) => item.id === chosen) : detected;
  if (!store) {
    return jsonResponse({ error: chosen ? NOT_FOUND : `SELECIONE A LOJA DO RELATÓRIO (CABEÇALHO: ${report.storeLabel || "SEM LOJA"}).` }, chosen ? 404 : 400);
  }

  const settings = await loadSettings(database);
  const months = Number(settings.historyMonths) || 0;
  const purgeBefore = months > 0 ? shiftDate(recifeDate(), { months }) : "";
  const sales = report.sales.filter((sale) => !purgeBefore || sale.saleDate >= purgeBefore);
  const existing = new Set(
    report.periodStart
      ? (await database
        .prepare("SELECT sale_no AS saleNo FROM fideliza_sales WHERE company_id=?1 AND sale_date BETWEEN ?2 AND ?3")
        .bind(store.id, report.periodStart, report.periodEnd)
        .all<{ saleNo: string }>()).results.map((row) => row.saleNo)
      : [],
  );
  const fresh = sales.filter((sale) => !existing.has(sale.saleNo));
  const purged = purgeBefore
    ? Number((await database.prepare("SELECT count(*) AS total FROM fideliza_sales WHERE company_id=?1 AND sale_date < ?2")
      .bind(store.id, purgeBefore).first<{ total: number }>())?.total) || 0
    : 0;
  const preview = {
    storeId: store.id, storeName: storeName(store), storeLabel: report.storeLabel, detectedStoreId: detected?.id || "",
    periodStart: report.periodStart, periodEnd: report.periodEnd, salesTotal: report.salesTotal,
    salesKept: sales.length, salesNew: fresh.length, customers: new Set(sales.map((sale) => sale.customerKey)).size,
    purged, purgeBefore,
  };
  if (payload.preview) return jsonResponse({ preview });

  const importId = crypto.randomUUID();
  const statements = [];
  if (purgeBefore) {
    statements.push(database.prepare("DELETE FROM fideliza_sales WHERE company_id=?1 AND sale_date < ?2").bind(store.id, purgeBefore));
  }
  for (let start = 0; start < fresh.length; start += INSERT_CHUNK) {
    const chunk = fresh.slice(start, start + INSERT_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((sale) => {
      const base = params.length;
      params.push(`${store.id}:${sale.saleNo}`, store.id, sale.saleNo, sale.saleDate, sale.customerKey, sale.customerName,
        sale.seller, sale.payment, sale.totalCents, JSON.stringify(sale.items), importId);
      return `(${Array.from({ length: 11 }, (_, index) => `?${base + index + 1}`).join(",")})`;
    });
    statements.push(database
      .prepare(`INSERT INTO fideliza_sales (id, company_id, sale_no, sale_date, customer_key, customer_name, seller, payment, total_cents, items_json, import_id)
        VALUES ${tuples.join(",")} ON CONFLICT (id) DO NOTHING`)
      .bind(...params));
  }
  statements.push(database
    .prepare(`INSERT INTO fideliza_imports (id, company_id, company_name, file_name, period_start, period_end, sales_total, sales_kept,
      sales_new, sales_purged, created_by, created_by_name, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`)
    .bind(importId, store.id, storeName(store), safeText(payload.fileName, 160), report.periodStart, report.periodEnd, report.salesTotal,
      sales.length, fresh.length, purged, actor.id, actor.displayName || actor.id, new Date().toISOString()));
  await database.batch(statements);
  return jsonResponse({ ok: true, preview }, 201);
}

async function registerContact(actor: Actor, database: Database, payload: Record<string, unknown>) {
  const store = viewStores(actor, await loadStores(database)).find((item) => item.id === safeText(payload.companyId, 80));
  if (!store) return jsonResponse({ error: NOT_FOUND }, 404);
  const key = safeText(payload.customerKey, 20);
  const result = safeText(payload.result, 30) as ContactResult;
  if (!(result in CONTACT_RESULTS)) return jsonResponse({ error: "SELECIONE O RESULTADO DO CONTATO." }, 400);
  const scheduledFor = result === "retorno_agendado" ? safeText(payload.scheduledFor, 10) : "";
  if (result === "retorno_agendado" && (!DATE.test(scheduledFor) || scheduledFor < recifeDate())) {
    return jsonResponse({ error: "INFORME A DATA DO RETORNO (HOJE OU DEPOIS)." }, 400);
  }
  const customer = await database
    .prepare("SELECT max(customer_name) AS name FROM fideliza_sales WHERE company_id=?1 AND customer_key=?2")
    .bind(store.id, key)
    .first<{ name: string | null }>();
  if (!customer?.name) return jsonResponse({ error: "CLIENTE NÃO ENCONTRADO." }, 404);
  const id = crypto.randomUUID();
  await database
    .prepare(`INSERT INTO fideliza_contacts (id, company_id, customer_key, customer_name, result, note, scheduled_for, created_by, created_by_name, created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
    .bind(id, store.id, key, customer.name, result, safeText(payload.note, 500), scheduledFor, actor.id, actor.displayName || actor.id, new Date().toISOString())
    .run();
  return jsonResponse({ id }, 201);
}

export async function POST(request: Request) {
  const payload = await body(request);
  const handlers = { import: importReport, contact: registerContact, export: exportCsv } as const;
  const action = String(payload.action) as keyof typeof handlers;
  if (!Object.hasOwn(handlers, action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  const checked = guard(request, action);
  if ("error" in checked) return checked.error;
  return handlers[action](checked.actor, await getD1(), payload);
}

export async function PUT(request: Request) {
  const checked = guard(request, "manage");
  if ("error" in checked) return checked.error;
  const payload = await body(request);
  const inactiveDays = Math.trunc(Number(payload.inactiveDays));
  const historyMonths = Math.trunc(Number(payload.historyMonths));
  const message = safeText(payload.message, 600).toLocaleUpperCase("pt-BR");
  if (!(inactiveDays >= 30 && inactiveDays <= 1095)) return jsonResponse({ error: "INATIVO: INFORME DE 30 A 1095 DIAS." }, 400);
  if (!(historyMonths >= 0 && historyMonths <= 120)) return jsonResponse({ error: "HISTÓRICO: INFORME DE 0 (TUDO) A 120 MESES." }, 400);
  if (!message) return jsonResponse({ error: "INFORME A MENSAGEM DO WHATSAPP." }, 400);
  const database = await getD1();
  await database
    .prepare(`INSERT INTO shared_state (state_key, value_json, version, updated_at) VALUES (?1, ?2, 1, ?3)
      ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, version = shared_state.version + 1, updated_at = excluded.updated_at`)
    .bind(SETTINGS_KEY, JSON.stringify({ inactiveDays, historyMonths, message }), new Date().toISOString())
    .run();
  return jsonResponse({ ok: true });
}
