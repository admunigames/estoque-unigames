import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany } from "../../../lib/access-scope";
import {
  allStoresFor,
  allStoresForAny,
  can,
  canAny,
  companyName,
  eventStatement,
  identity,
  inScope,
  jsonResponse,
  loadItems,
  loadRequest,
  parseItems,
  READ_PERMISSIONS,
  recalcStatement,
  routeParam,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

type Context = { params: Promise<{ id: string }> };

type EventRow = {
  id: string;
  itemId: string;
  kind: string;
  fromStatus: string;
  toStatus: string;
  text: string;
  actorName: string;
  createdAt: string;
};

const NOT_FOUND = "PEDIDO NÃO ENCONTRADO.";

export async function GET(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAny(actor, READ_PERMISSIONS)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VISUALIZAR AS DIVERGÊNCIAS." }, 403);
  }
  try {
    const id = routeParam((await context.params).id);
    const database = await getD1();
    const row = await loadRequest(database, id);
    const visible =
      row && (allStoresForAny(actor, READ_PERMISSIONS) ||
        (hasCompany(actor.companyId) && actor.companyId === row.companyId));
    if (!row || !visible) return jsonResponse({ error: NOT_FOUND }, 404);
    const [items, events] = await Promise.all([
      loadItems(database, id),
      database
        .prepare(
          `SELECT id, item_id AS itemId, kind, from_status AS fromStatus, to_status AS toStatus, text,
                  actor_name AS actorName, created_at AS createdAt
           FROM divergence_item_events WHERE request_id=?1 ORDER BY created_at, id`,
        )
        .bind(id)
        .all<EventRow>(),
    ]);
    const byItem = new Map<string, EventRow[]>();
    for (const event of events.results ?? []) {
      const list = byItem.get(event.itemId) || [];
      list.push(event);
      byItem.set(event.itemId, list);
    }
    return jsonResponse({
      request: row,
      items: items.map((item) => ({ ...item, events: byItem.get(item.id) || [] })),
    });
  } catch (error) {
    console.error("Não foi possível carregar o pedido de divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O PEDIDO DE DIVERGÊNCIA." }, 500);
  }
}

// Edição pela loja: substitui a lista de itens (itens com id existente são
// atualizados, sem id são incluídos, ausentes são removidos). Mudar produto
// ou quantidades de um item já respondido devolve o item para NÃO VISTO e
// registra "ALTERADO PELA LOJA" no histórico (regra assumida, ver tarefa).
export async function PATCH(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "divergencias:edit")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR PEDIDOS DE DIVERGÊNCIA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const id = routeParam((await context.params).id);
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const row = await loadRequest(database, id);
    if (!row || !inScope(actor, "divergencias:edit", row.companyId)) {
      return jsonResponse({ error: NOT_FOUND }, 404);
    }
    const parsed = parseItems(body.items);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const notes = safeText(body.notes, 2000);

    let nextCompanyId = row.companyId;
    let nextCompanyName = row.companyName;
    const requestedCompany = safeText(body.companyId, 80);
    if (requestedCompany && requestedCompany !== row.companyId) {
      if (!allStoresFor(actor, "divergencias:edit")) {
        return jsonResponse({ error: "VOCÊ NÃO PODE TROCAR A LOJA DESTE PEDIDO." }, 403);
      }
      const resolved = hasCompany(requestedCompany) ? await companyName(database, requestedCompany) : "";
      if (!resolved) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
      nextCompanyId = requestedCompany;
      nextCompanyName = resolved;
    }

    const existing = new Map((await loadItems(database, id)).map((item) => [item.id, item]));
    const keep = new Set<string>();
    const at = new Date().toISOString();
    const statements = [
      database
        .prepare(`UPDATE divergence_requests SET notes=?1, company_id=?2, company_name=?3 WHERE id=?4`)
        .bind(notes, nextCompanyId, nextCompanyName, id),
    ];
    for (const [position, item] of parsed.items.entries()) {
      const current = item.id ? existing.get(item.id) : undefined;
      if (!current) {
        const itemId = crypto.randomUUID();
        statements.push(
          database
            .prepare(
              `INSERT INTO divergence_items
                (id, request_id, product_code, product_name, position, physical_qty, system_qty, store_notes,
                 status, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'nao_visto', ?9, ?10, ?11, ?9, ?10, ?11)`,
            )
            .bind(itemId, id, item.productCode, item.productName, position, item.physicalQty, item.systemQty,
              item.storeNotes, actor.id, actor.displayName, at),
          eventStatement(database, {
            itemId, requestId: id, kind: "created", fromStatus: "", toStatus: "nao_visto",
            text: item.storeNotes, actor, at,
          }),
        );
        continue;
      }
      keep.add(current.id);
      statements.push(
        database.prepare("UPDATE divergence_items SET position=?1 WHERE id=?2").bind(position, current.id),
      );
      const changes: string[] = [];
      if (current.productName !== item.productName || current.productCode !== item.productCode) {
        changes.push(`PRODUTO: ${current.productName} → ${item.productName}`);
      }
      if (current.physicalQty !== item.physicalQty) {
        changes.push(`FÍSICO: ${current.physicalQty} → ${item.physicalQty}`);
      }
      if (current.systemQty !== item.systemQty) {
        changes.push(`SISTEMA: ${current.systemQty} → ${item.systemQty}`);
      }
      const notesChanged = current.storeNotes !== item.storeNotes;
      if (!changes.length && !notesChanged) continue;
      if (changes.length) {
        // Produto/quantidade mudou: a resposta anterior deixa de valer (fica
        // no histórico) e o item volta para a fila do estoque.
        statements.push(
          database
            .prepare(
              `UPDATE divergence_items
               SET product_code=?1, product_name=?2, physical_qty=?3, system_qty=?4, store_notes=?5,
                   status='nao_visto', stock_response='', responded_by='', responded_by_name='',
                   responded_at='', inventoried_at='', inventoried_by='', inventoried_by_name='',
                   updated_by=?6, updated_by_name=?7, updated_at=?8
               WHERE id=?9`,
            )
            .bind(item.productCode, item.productName, item.physicalQty, item.systemQty, item.storeNotes,
              actor.id, actor.displayName, at, current.id),
          eventStatement(database, {
            itemId: current.id, requestId: id, kind: "store_edit",
            fromStatus: current.status, toStatus: "nao_visto",
            text: `ALTERADO PELA LOJA — ${changes.join(" · ")}${notesChanged ? ` · OBS.: ${item.storeNotes || "—"}` : ""}`,
            actor, at,
          }),
        );
      } else {
        statements.push(
          database
            .prepare(
              `UPDATE divergence_items SET store_notes=?1, updated_by=?2, updated_by_name=?3, updated_at=?4
               WHERE id=?5`,
            )
            .bind(item.storeNotes, actor.id, actor.displayName, at, current.id),
          eventStatement(database, {
            itemId: current.id, requestId: id, kind: "store_edit",
            fromStatus: current.status, toStatus: current.status,
            text: `OBSERVAÇÃO DA LOJA ALTERADA: ${item.storeNotes || "—"}`, actor, at,
          }),
        );
      }
    }
    for (const current of existing.values()) {
      if (keep.has(current.id)) continue;
      statements.push(
        database.prepare("DELETE FROM divergence_item_events WHERE item_id=?1").bind(current.id),
        database.prepare("DELETE FROM divergence_items WHERE id=?1").bind(current.id),
      );
    }
    statements.push(recalcStatement(database, id, actor, at));
    await database.batch(statements);
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível editar o pedido de divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O PEDIDO DE DIVERGÊNCIA." }, 500);
  }
}

// Excluir o pedido remove também os itens (inclusive pendências de
// inventário que vieram dele) e o histórico.
export async function DELETE(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "divergencias:delete")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR PEDIDOS DE DIVERGÊNCIA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const id = routeParam((await context.params).id);
    const database = await getD1();
    const row = await loadRequest(database, id);
    if (!row || !inScope(actor, "divergencias:delete", row.companyId)) {
      return jsonResponse({ error: NOT_FOUND }, 404);
    }
    await database.batch([
      database.prepare("DELETE FROM divergence_item_events WHERE request_id=?1").bind(id),
      database.prepare("DELETE FROM divergence_items WHERE request_id=?1").bind(id),
      database.prepare("DELETE FROM divergence_requests WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o pedido de divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O PEDIDO DE DIVERGÊNCIA." }, 500);
  }
}
