import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { hasCompany, NO_COMPANY_ERROR } from "../../lib/access-scope";
import {
  isDateOnly,
  isOverdueUnseen,
  isRequestStatus,
  recifeDayStartIso,
  recifeNextDayStartIso,
} from "../../lib/divergences";
import {
  allStoresFor,
  allStoresForAny,
  canAny,
  can,
  companyName,
  eventStatement,
  identity,
  jsonResponse,
  parseItems,
  READ_PERMISSIONS,
  REQUEST_SELECT,
  safeText,
  sameOrigin,
  type JsonMap,
  type RequestRow,
} from "./shared";

type ItemStatusRow = { requestId: string; status: string; createdAt: string };

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAny(actor, READ_PERMISSIONS)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VISUALIZAR AS DIVERGÊNCIAS." }, 403);
  }

  try {
    const url = new URL(request.url);
    const allStores = allStoresForAny(actor, READ_PERMISSIONS);
    if (!allStores && !hasCompany(actor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      params.push(value);
      conditions.push(condition.replace("?", `?${params.length}`));
    };
    const requestedCompany = safeText(url.searchParams.get("companyId"), 80);
    if (!allStores) add("company_id=?", actor.companyId);
    else if (hasCompany(requestedCompany)) add("company_id=?", requestedCompany);
    const status = url.searchParams.get("status");
    if (isRequestStatus(status)) add("status=?", status);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (isDateOnly(from)) add("created_at>=?", recifeDayStartIso(from));
    if (isDateOnly(to)) add("created_at<?", recifeNextDayStartIso(to));
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

    const database = await getD1();
    const requests = await database
      .prepare(
        `${REQUEST_SELECT}${where}
         ORDER BY CASE status WHEN 'finalizado' THEN 1 ELSE 0 END, created_at DESC
         LIMIT 500`,
      )
      .bind(...params)
      .all<RequestRow>();
    const rows = requests.results ?? [];
    const items = rows.length
      ? await database
          .prepare(
            `SELECT i.request_id AS requestId, i.status, i.created_at AS createdAt
             FROM divergence_items i
             WHERE i.request_id IN (SELECT id FROM divergence_requests${where})`,
          )
          .bind(...params)
          .all<ItemStatusRow>()
      : { results: [] as ItemStatusRow[] };
    const counters = new Map<string, { total: number; overdue: number; byStatus: Record<string, number> }>();
    const now = new Date();
    for (const item of items.results ?? []) {
      const entry = counters.get(item.requestId) || { total: 0, overdue: 0, byStatus: {} };
      entry.total += 1;
      entry.byStatus[item.status] = (entry.byStatus[item.status] || 0) + 1;
      if (isOverdueUnseen(item.status, item.createdAt, now)) entry.overdue += 1;
      counters.set(item.requestId, entry);
    }
    return jsonResponse({
      allStores,
      requests: rows.map((row) => {
        const entry = counters.get(row.id) || { total: 0, overdue: 0, byStatus: {} };
        return { ...row, itemCount: entry.total, overdueCount: entry.overdue, itemsByStatus: entry.byStatus };
      }),
    });
  } catch (error) {
    console.error("Não foi possível carregar as divergências.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS DIVERGÊNCIAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "divergencias:create")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR PEDIDOS DE DIVERGÊNCIA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const canChooseCompany = allStoresFor(actor, "divergencias:create");
    const companyId = canChooseCompany ? safeText(body.companyId, 80) : actor.companyId;
    if (!hasCompany(companyId)) {
      return jsonResponse({ error: canChooseCompany ? "ESCOLHA A LOJA." : NO_COMPANY_ERROR }, 400);
    }
    const parsed = parseItems(body.items);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const notes = safeText(body.notes, 2000);

    const database = await getD1();
    const resolvedCompanyName = await companyName(database, companyId);
    if (!resolvedCompanyName) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);

    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const statements = [
      database
        .prepare(
          `INSERT INTO divergence_requests
            (id, company_id, company_name, status, notes, finalized_at, created_by, created_by_name,
             created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, 'aberto', ?4, '', ?5, ?6, ?7, ?5, ?6, ?7)`,
        )
        .bind(id, companyId, resolvedCompanyName, notes, actor.id, actor.displayName, at),
    ];
    for (const [position, item] of parsed.items.entries()) {
      const itemId = crypto.randomUUID();
      statements.push(
        database
          .prepare(
            `INSERT INTO divergence_items
              (id, request_id, product_code, product_name, position, physical_qty, system_qty, store_notes,
               status, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'nao_visto', ?9, ?10, ?11, ?9, ?10, ?11)`,
          )
          .bind(
            itemId,
            id,
            item.productCode,
            item.productName,
            position,
            item.physicalQty,
            item.systemQty,
            item.storeNotes,
            actor.id,
            actor.displayName,
            at,
          ),
        eventStatement(database, {
          itemId,
          requestId: id,
          kind: "created",
          fromStatus: "",
          toStatus: "nao_visto",
          text: item.storeNotes,
          actor,
          at,
        }),
      );
    }
    await database.batch(statements);
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível registrar o pedido de divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O PEDIDO DE DIVERGÊNCIA." }, 500);
  }
}
