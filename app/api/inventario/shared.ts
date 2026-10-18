import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canActOnStore, resolveStoreScope } from "../../lib/access-scope";
import { isSellingStore } from "../../lib/selling-stores";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";

// Base comum de Estoque > Inventário (permissões inventario:view/count/
// manage/delete). Escopo de loja de sempre: login com loja vê e conta só os
// inventários da própria loja; sem loja vê todas (decisão do usuário,
// 18/10/2026: quem tem o módulo habilitado é quem conta).

export type Actor = ReturnType<typeof identity>;
export type Database = Awaited<ReturnType<typeof getD1>>;
export type InventoryRow = { id: string; storeId: string; storeName: string; status: string };

export { identity, jsonResponse, safeText, sameOrigin };

export const PERMISSIONS = ["view", "count", "manage", "delete"].map((action) => `inventario:${action}`);
export const NOT_FOUND = "INVENTÁRIO NÃO ENCONTRADO.";

export function can(actor: Actor, action: string) {
  return actor.role === "admin" || actor.permissions.includes(`inventario:${action}`);
}

export function canView(actor: Actor) {
  return actor.role === "admin" || PERMISSIONS.some((permission) => actor.permissions.includes(permission));
}

/** Autenticação + permissão (+ mesma origem nas gravações). */
export function guard(request: Request, actions: string[], message: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!actions.some((action) => can(actor, action))) return { error: jsonResponse({ error: message }, 403) };
  if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
    return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  }
  return { actor };
}

export function storeScope(actor: Actor) {
  return resolveStoreScope(actor, "inventario:view");
}

/** Inventário pelo id, só se estiver no escopo de loja do ator (fora = 404). */
export async function findInventory(database: Database, actor: Actor, id: string): Promise<InventoryRow | null> {
  const row = id
    ? await database
      .prepare("SELECT id, store_id AS storeId, store_name AS storeName, status FROM inventories WHERE id=?1 AND deleted=0")
      .bind(id)
      .first<InventoryRow>()
    : null;
  return row && canActOnStore(actor, "inventario:view", row.storeId) ? row : null;
}

export async function loadStores(database: Database) {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  try {
    const list = row?.value ? (JSON.parse(row.value) as { id: string; name: string }[]) : [];
    return Array.isArray(list)
      ? list.filter((item) => item && typeof item.id === "string" && isSellingStore(String(item.name || "")))
      : [];
  } catch {
    return [];
  }
}

export function upper(value: unknown, max: number) {
  return safeText(value, max).toLocaleUpperCase("pt-BR");
}
