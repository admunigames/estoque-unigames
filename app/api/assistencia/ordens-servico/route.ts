import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canActOnStore, hasCompany, NO_COMPANY_ERROR, resolveStoreScope } from "../../../lib/access-scope";
import { isSellingStore } from "../../../lib/selling-stores";
import {
  compareOrders,
  DATE_PATTERN,
  deadlineInfo,
  OS_CATEGORIES,
  OS_CLOSED_STATUS,
  OS_STATUSES,
  recifeDate,
} from "../../../lib/ordens-servico";
import { identity as baseIdentity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Assistência > Ordens de Serviço (permissões ordens_servico:view/create/
// edit/delete). Login com loja vinculada só VISUALIZA as O.S. da própria
// loja (decisão do usuário, 14/10/2026); sem loja vê e mexe em todas.
//   GET    [?closed=1]        → O.S. abertas (ou finalizadas), da mais crítica
//   GET    ?updates=<id>      → histórico da atualização diária da O.S.
//   POST   {osNumber, category, equipment, status, storeId, deadline, situation, updateText?}
//   PATCH  {id, ...mesmos campos}  → edita (ordens_servico:edit)
//   PUT    {id, text}         → nova atualização diária (ordens_servico:edit)
//   DELETE {id}               → exclui (canceled=1; ordens_servico:delete)

type Actor = ReturnType<typeof baseIdentity> & { companyId: string };
type Company = { id: string; name: string };

const PERMISSIONS = ["view", "create", "edit", "delete"].map((action) => `ordens_servico:${action}`);
const NOT_FOUND = "O.S. NÃO ENCONTRADA.";

function identity(request: Request): Actor {
  return { ...baseIdentity(request), companyId: safeText(request.headers.get("x-unigames-company-id"), 80) };
}

function can(actor: Actor, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

async function loadCompanies(database: D1Database): Promise<Company[]> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  try {
    const list = row?.value ? (JSON.parse(row.value) as Company[]) : [];
    return Array.isArray(list)
      ? list.filter((item) => item && typeof item.id === "string" && isSellingStore(String(item.name || "")))
      : [];
  } catch {
    return [];
  }
}

function writeGuard(request: Request, action: string, message: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!can(actor, `ordens_servico:${action}`)) return { error: jsonResponse({ error: message }, 403) };
  if (actor.role !== "admin" && hasCompany(actor.companyId)) {
    return { error: jsonResponse({ error: "LOGIN DE LOJA SÓ VISUALIZA AS ORDENS DE SERVIÇO." }, 403) };
  }
  if (!sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

type OrderInput = {
  osNumber: string; category: string; equipment: string; status: string;
  storeId: string; deadline: string; situation: string;
};

function parseOrder(body: JsonMap): { error: string } | { order: OrderInput } {
  const upper = (value: unknown, max: number) => safeText(value, max).toLocaleUpperCase("pt-BR");
  const order = {
    osNumber: upper(body.osNumber, 40),
    category: upper(body.category, 20),
    equipment: upper(body.equipment, 120),
    status: upper(body.status, 40),
    storeId: safeText(body.storeId, 80),
    deadline: safeText(body.deadline, 10),
    situation: upper(body.situation, 120),
  };
  if (!order.osNumber) return { error: "INFORME O NÚMERO DA O.S." };
  if (!(OS_CATEGORIES as readonly string[]).includes(order.category)) return { error: "ESCOLHA O TIPO (ABA) DA O.S." };
  if (!(OS_STATUSES as readonly string[]).includes(order.status)) return { error: "ESCOLHA O STATUS DA O.S." };
  if (order.deadline && !DATE_PATTERN.test(order.deadline)) return { error: "DATA LIMITE INVÁLIDA." };
  return { order };
}

async function findOrder(database: D1Database, actor: Actor, id: string, permission: string) {
  const row = id
    ? await database
      .prepare("SELECT id, store_id AS storeId, status FROM assist_service_orders WHERE id=?1 AND canceled=0")
      .bind(id)
      .first<{ id: string; storeId: string; status: string }>()
    : null;
  return row && canActOnStore(actor, permission, row.storeId) ? row : null;
}

async function osNumberTaken(database: D1Database, osNumber: string, exceptId: string) {
  const row = await database
    .prepare("SELECT id FROM assist_service_orders WHERE os_number=?1 AND canceled=0 AND closed=0 AND id<>?2")
    .bind(osNumber, exceptId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!PERMISSIONS.some((permission) => can(actor, permission))) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO ÀS ORDENS DE SERVIÇO." }, 403);
  }
  const scope = resolveStoreScope(actor, "ordens_servico:view");
  if (scope.blocked) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const url = new URL(request.url);
  try {
    const database = await getD1();
    const updatesFor = safeText(url.searchParams.get("updates"), 80);
    if (updatesFor) {
      const order = await findOrder(database, actor, updatesFor, "ordens_servico:view");
      if (!order) return jsonResponse({ error: NOT_FOUND }, 404);
      const result = await database
        .prepare(
          `SELECT id, update_text AS text, created_by_name AS createdByName, created_at AS createdAt
           FROM assist_service_order_updates WHERE order_id=?1 ORDER BY created_at DESC`,
        )
        .bind(order.id)
        .all<JsonMap>();
      return jsonResponse({ updates: result.results ?? [] });
    }

    const closed = url.searchParams.get("closed") === "1" ? 1 : 0;
    const storeFilter = scope.allStores ? "" : " AND store_id=?2";
    const statement = database.prepare(
      `SELECT id, os_number AS osNumber, category, equipment, status, store_id AS storeId, store_name AS storeName,
              deadline, situation, closed, closed_at AS closedAt, last_update_text AS lastUpdateText,
              last_update_at AS lastUpdateAt, last_update_by_name AS lastUpdateByName,
              created_by_name AS createdByName, created_at AS createdAt, updated_by_name AS updatedByName, updated_at AS updatedAt
       FROM assist_service_orders WHERE canceled=0 AND closed=?1${storeFilter}
       ORDER BY ${closed ? "closed_at DESC LIMIT 300" : "deadline"}`,
    );
    const [result, allCompanies] = await Promise.all([
      (scope.allStores ? statement.bind(closed) : statement.bind(closed, actor.companyId)).all<JsonMap>(),
      loadCompanies(database),
    ]);
    const today = recifeDate();
    const orders = (result.results ?? [])
      .map((row) => {
        const order = {
          ...row,
          osNumber: String(row.osNumber),
          deadline: String(row.deadline || ""),
          closed: Number(row.closed),
          closedAt: String(row.closedAt || ""),
        };
        const info = deadlineInfo(order.deadline, today);
        return {
          ...order,
          deadlineDays: info.days,
          deadlineLevel: order.closed ? "finalizada" : info.level,
          updatedToday: recifeDate(String(row.lastUpdateAt || "")) === today,
        };
      })
      .sort(compareOrders);
    const companies = scope.allStores ? allCompanies : allCompanies.filter((company) => company.id === actor.companyId);
    return jsonResponse({ today, allStores: scope.allStores, companies, orders });
  } catch (error) {
    console.error("Não foi possível carregar as ordens de serviço.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS ORDENS DE SERVIÇO." }, 500);
  }
}

export async function POST(request: Request) {
  const guard = writeGuard(request, "create", "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR O.S.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const parsed = parseOrder(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { order } = parsed;
    const database = await getD1();
    const store = (await loadCompanies(database)).find((company) => company.id === order.storeId);
    if (!store) return jsonResponse({ error: "ESCOLHA A LOJA RESPONSÁVEL." }, 400);
    if (await osNumberTaken(database, order.osNumber, "")) {
      return jsonResponse({ error: `JÁ EXISTE UMA O.S. ${order.osNumber} EM ABERTO.` }, 409);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const updateText = safeText(body.updateText, 2000);
    const closed = order.status === OS_CLOSED_STATUS ? 1 : 0;
    const statements = [
      database
        .prepare(
          `INSERT INTO assist_service_orders
            (id, os_number, category, equipment, status, store_id, store_name, deadline, situation, closed, closed_at,
             last_update_text, last_update_at, last_update_by_name, canceled, source, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, 'manual', ?15, ?16, ?17)`,
        )
        .bind(id, order.osNumber, order.category, order.equipment, order.status, store.id, store.name, order.deadline,
          order.situation, closed, closed ? now : "", updateText, updateText ? now : "", updateText ? actor.displayName : "",
          actor.id, actor.displayName, now),
    ];
    if (updateText) {
      statements.push(
        database
          .prepare(
            `INSERT INTO assist_service_order_updates (id, order_id, update_text, created_by, created_by_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(crypto.randomUUID(), id, updateText, actor.id, actor.displayName, now),
      );
    }
    await database.batch(statements);
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a ordem de serviço.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A O.S." }, 500);
  }
}

export async function PATCH(request: Request) {
  const guard = writeGuard(request, "edit", "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR O.S.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const parsed = parseOrder(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { order } = parsed;
    const database = await getD1();
    const existing = await findOrder(database, actor, safeText(body.id, 80), "ordens_servico:edit");
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    const store = (await loadCompanies(database)).find((company) => company.id === order.storeId);
    if (!store) return jsonResponse({ error: "ESCOLHA A LOJA RESPONSÁVEL." }, 400);
    const closed = order.status === OS_CLOSED_STATUS ? 1 : 0;
    if (!closed && await osNumberTaken(database, order.osNumber, existing.id)) {
      return jsonResponse({ error: `JÁ EXISTE UMA O.S. ${order.osNumber} EM ABERTO.` }, 409);
    }
    const now = new Date().toISOString();
    // closed_at só muda quando a O.S. entra/sai de FINALIZADA.
    const wasClosed = existing.status === OS_CLOSED_STATUS;
    const closedAt = closed ? (wasClosed ? null : now) : "";
    await database
      .prepare(
        `UPDATE assist_service_orders
         SET os_number=?1, category=?2, equipment=?3, status=?4, store_id=?5, store_name=?6, deadline=?7, situation=?8,
             closed=?9, closed_at=COALESCE(?10, closed_at), updated_by=?11, updated_by_name=?12, updated_at=?13
         WHERE id=?14`,
      )
      .bind(order.osNumber, order.category, order.equipment, order.status, store.id, store.name, order.deadline,
        order.situation, closed, closedAt, actor.id, actor.displayName, now, existing.id)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível editar a ordem de serviço.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A O.S." }, 500);
  }
}

export async function PUT(request: Request) {
  const guard = writeGuard(request, "edit", "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR O.S.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const text = safeText(body.text, 2000);
    if (!text) return jsonResponse({ error: "ESCREVA A ATUALIZAÇÃO." }, 400);
    const database = await getD1();
    const existing = await findOrder(database, actor, safeText(body.id, 80), "ordens_servico:edit");
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    const now = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `INSERT INTO assist_service_order_updates (id, order_id, update_text, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(crypto.randomUUID(), existing.id, text, actor.id, actor.displayName, now),
      database
        .prepare("UPDATE assist_service_orders SET last_update_text=?1, last_update_at=?2, last_update_by_name=?3 WHERE id=?4")
        .bind(text, now, actor.displayName, existing.id),
    ]);
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível registrar a atualização da O.S.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A ATUALIZAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const guard = writeGuard(request, "delete", "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR O.S.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const existing = await findOrder(database, actor, safeText(body.id, 80), "ordens_servico:delete");
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    await database
      .prepare("UPDATE assist_service_orders SET canceled=1, updated_by=?1, updated_by_name=?2, updated_at=?3 WHERE id=?4")
      .bind(actor.id, actor.displayName, new Date().toISOString(), existing.id)
      .run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a ordem de serviço.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A O.S." }, 500);
  }
}
