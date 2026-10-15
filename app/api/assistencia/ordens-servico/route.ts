import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canActOnStore, hasCompany, NO_COMPANY_ERROR, resolveStoreScope } from "../../../lib/access-scope";
import { isSellingStore } from "../../../lib/selling-stores";
import {
  approvalState,
  compareOrders,
  DATE_PATTERN,
  deadlineInfo,
  OS_APPROVED_STATUS,
  OS_CATEGORIES,
  OS_RETURN_STATUSES,
  OS_STATUSES,
  OS_STORE_REJECTED_STATUS,
  recifeDate,
  type ShipToStore,
  type StoreCheck,
} from "../../../lib/ordens-servico";
import { identity as baseIdentity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Assistência > Ordens de Serviço (permissões ordens_servico:view/create/
// edit/delete/store_test). Login com loja vinculada só VISUALIZA as O.S. da
// própria loja (decisão do usuário, 14/10/2026); sem loja vê e mexe em todas.
// Exceção: com ordens_servico:store_test a loja aprova ou reprova o teste das
// O.S. APROVADAS que seguiram para ela (reprovada volta para a assistência).
//   GET    [?closed=1]        → O.S. abertas (ou finalizadas), da mais crítica
//   GET    ?updates=<id>      → histórico da atualização diária da O.S.
//   POST   {osNumber, category, equipment, status, storeId, deadline, situation, updateText?}
//   PATCH  {id, ...mesmos campos, shipToStore}  → edita (ordens_servico:edit)
//   PATCH  {id, action:"store_test", result:"aprovada"|"reprovada", note} → teste da loja
//   PUT    {id, text}         → nova atualização diária (ordens_servico:edit)
//   DELETE {id}               → exclui (canceled=1; ordens_servico:delete)

type Actor = ReturnType<typeof baseIdentity> & { companyId: string };
type Company = { id: string; name: string };
type ExistingOrder = { id: string; storeId: string; status: string; shipToStore: ShipToStore; storeCheck: StoreCheck };

const PERMISSIONS = ["view", "create", "edit", "delete", "store_test"].map((action) => `ordens_servico:${action}`);
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
  storeId: string; deadline: string; situation: string; shipToStore: ShipToStore;
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
    shipToStore: (body.shipToStore === "sim" || body.shipToStore === "nao" ? body.shipToStore : "") as ShipToStore,
  };
  if (!order.osNumber) return { error: "INFORME O NÚMERO DA O.S." };
  if (!(OS_CATEGORIES as readonly string[]).includes(order.category)) return { error: "ESCOLHA O TIPO (ABA) DA O.S." };
  if (!(OS_STATUSES as readonly string[]).includes(order.status)) return { error: "ESCOLHA O STATUS DA O.S." };
  if (order.deadline && !DATE_PATTERN.test(order.deadline)) return { error: "DATA LIMITE INVÁLIDA." };
  if (order.status === OS_APPROVED_STATUS && !order.shipToStore) return { error: "INFORME SE O PRODUTO SEGUE PARA A LOJA." };
  if (OS_RETURN_STATUSES.includes(order.status)) order.shipToStore = "sim";
  else if (order.status !== OS_APPROVED_STATUS) order.shipToStore = "";
  return { order };
}

async function findOrder(database: D1Database, actor: Actor, id: string, permission: string) {
  const row = id
    ? await database
      .prepare(
        `SELECT id, store_id AS storeId, status, ship_to_store AS shipToStore, store_check AS storeCheck
         FROM assist_service_orders WHERE id=?1 AND canceled=0`,
      )
      .bind(id)
      .first<ExistingOrder>()
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
              ship_to_store AS shipToStore, ship_by_name AS shipByName, ship_at AS shipAt,
              store_check AS storeCheck, store_check_by_name AS storeCheckByName, store_check_at AS storeCheckAt,
              store_check_note AS storeCheckNote,
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
    const { closed, storeCheck } = approvalState(order.status, order.shipToStore, "");
    const statements = [
      database
        .prepare(
          `INSERT INTO assist_service_orders
            (id, os_number, category, equipment, status, store_id, store_name, deadline, situation, closed, closed_at,
             last_update_text, last_update_at, last_update_by_name, ship_to_store, ship_by_name, ship_at, store_check,
             canceled, source, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 0, 'manual', ?19, ?20, ?21)`,
        )
        .bind(id, order.osNumber, order.category, order.equipment, order.status, store.id, store.name, order.deadline,
          order.situation, closed, closed ? now : "", updateText, updateText ? now : "", updateText ? actor.displayName : "",
          order.shipToStore, order.shipToStore ? actor.displayName : "", order.shipToStore ? now : "", storeCheck,
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

function historyEntry(database: D1Database, orderId: string, text: string, actor: Actor, now: string) {
  return database
    .prepare(
      `INSERT INTO assist_service_order_updates (id, order_id, update_text, created_by, created_by_name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(crypto.randomUUID(), orderId, text, actor.id, actor.displayName, now);
}

function dateBR(iso: string) {
  const [year, month, day] = recifeDate(iso).split("-");
  return `${day}/${month}/${year}`;
}

// Teste da loja: só O.S. APROVADA que seguiu para a loja (store_check
// pendente), da própria loja. Aprovada → finaliza; reprovada → volta para a
// assistência como REPROVADO EM LOJA, com quem reprovou, data e motivo.
async function storeTest(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "ordens_servico:store_test")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA TESTAR A O.S. NA LOJA." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const body = (await request.clone().json().catch(() => ({}))) as JsonMap;
  const result = body.result === "aprovada" || body.result === "reprovada" ? body.result : "";
  if (!result) return jsonResponse({ error: "ESCOLHA APROVADA OU REPROVADO EM LOJA." }, 400);
  const note = safeText(body.note, 1000).toLocaleUpperCase("pt-BR");
  if (result === "reprovada" && !note) return jsonResponse({ error: "INFORME O MOTIVO DA REPROVAÇÃO." }, 400);
  const database = await getD1();
  const existing = await findOrder(database, actor, safeText(body.id, 80), "ordens_servico:store_test");
  if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
  if (existing.status !== OS_APPROVED_STATUS || existing.storeCheck !== "pendente") {
    return jsonResponse({ error: "ESTA O.S. NÃO ESTÁ AGUARDANDO TESTE DA LOJA." }, 409);
  }
  const now = new Date().toISOString();
  const approved = result === "aprovada";
  const text = approved
    ? `APROVADA NA LOJA POR ${actor.displayName} EM ${dateBR(now)}${note ? ` - ${note}` : ""}`
    : `REPROVADO EM LOJA POR ${actor.displayName} EM ${dateBR(now)} - ${note}`;
  await database.batch([
    database
      .prepare(
        `UPDATE assist_service_orders
         SET status=?1, closed=?2, closed_at=?3, store_check=?4, store_check_by_name=?5, store_check_at=?6,
             store_check_note=?7, last_update_text=?8, last_update_at=?6, last_update_by_name=?5,
             updated_by=?9, updated_by_name=?5, updated_at=?6
         WHERE id=?10`,
      )
      .bind(approved ? OS_APPROVED_STATUS : OS_STORE_REJECTED_STATUS, approved ? 1 : 0, approved ? now : "",
        result, actor.displayName, now, note, text, actor.id, existing.id),
    historyEntry(database, existing.id, text, actor, now),
  ]);
  return jsonResponse({ updated: true, result });
}

export async function PATCH(request: Request) {
  const peek = (await request.clone().json().catch(() => ({}))) as JsonMap;
  if (peek.action === "store_test") {
    try {
      return await storeTest(request);
    } catch (error) {
      console.error("Não foi possível registrar o teste da loja.", error);
      return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O TESTE DA LOJA." }, 500);
    }
  }
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
    const { closed, storeCheck } = approvalState(order.status, order.shipToStore, existing.storeCheck);
    if (!closed && await osNumberTaken(database, order.osNumber, existing.id)) {
      return jsonResponse({ error: `JÁ EXISTE UMA O.S. ${order.osNumber} EM ABERTO.` }, 409);
    }
    const now = new Date().toISOString();
    const shipChanged = order.shipToStore !== existing.shipToStore;
    const statusChanged = order.status !== existing.status;
    const statements = [
      database
        .prepare(
          `UPDATE assist_service_orders
           SET os_number=?1, category=?2, equipment=?3, status=?4, store_id=?5, store_name=?6, deadline=?7, situation=?8,
               closed=?9, closed_at=CASE WHEN ?9=1 AND closed=1 THEN closed_at WHEN ?9=1 THEN ?13 ELSE '' END,
               ship_to_store=?10, ship_by_name=CASE WHEN ?14=1 THEN ?12 ELSE ship_by_name END,
               ship_at=CASE WHEN ?14=1 THEN ?13 ELSE ship_at END, store_check=?15,
               updated_by=?11, updated_by_name=?12, updated_at=?13
           WHERE id=?16`,
        )
        .bind(order.osNumber, order.category, order.equipment, order.status, store.id, store.name, order.deadline,
          order.situation, closed, order.shipToStore, actor.id, actor.displayName, now, shipChanged ? 1 : 0, storeCheck,
          existing.id),
    ];
    // Mudança de status (e o SEGUE PARA A LOJA) entra no histórico com quem fez.
    if (statusChanged || shipChanged) {
      const ship = OS_RETURN_STATUSES.includes(order.status) ? " · SEGUE PARA A LOJA PARA DEVOLVER AO CLIENTE"
        : order.shipToStore === "sim" ? " · SEGUE PARA A LOJA" : order.shipToStore === "nao" ? " · NÃO SEGUE PARA A LOJA" : "";
      statements.push(historyEntry(database, existing.id, `STATUS: ${order.status}${ship}`, actor, now));
    }
    await database.batch(statements);
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
