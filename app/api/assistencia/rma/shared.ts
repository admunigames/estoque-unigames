import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canActOnStore, hasCompany, resolveStoreScope } from "../../../lib/access-scope";
import { identity as baseIdentity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Base comum de Assistência > RMA (permissões rma:view/create/edit/finance/
// delete). Login com loja só VISUALIZA os RMAs da própria loja e a linha do
// tempo de atualizações — nada de créditos, descartes ou fornecedores
// (decisão do usuário, 22/10/2026). RMA AVULSO (store_id '') só quem vê todas
// as lojas enxerga. Gravação: só login sem loja (ou admin).

export type Actor = ReturnType<typeof baseIdentity> & { companyId: string };
export type Database = Awaited<ReturnType<typeof getD1>>;
export type CaseRow = { id: string; code: string; storeId: string; status: string; finalized: number };

export { jsonResponse, safeText, type JsonMap };

export const PERMISSIONS = ["view", "create", "edit", "finance", "delete"].map((action) => `rma:${action}`);
export const NOT_FOUND = "RMA NÃO ENCONTRADO.";

export function identity(request: Request): Actor {
  return { ...baseIdentity(request), companyId: safeText(request.headers.get("x-unigames-company-id"), 80) };
}

export function can(actor: Actor, action: string) {
  return actor.role === "admin" || actor.permissions.includes(`rma:${action}`);
}

export function canView(actor: Actor) {
  return actor.role === "admin" || PERMISSIONS.some((permission) => actor.permissions.includes(permission));
}

/** Login com loja (não admin): só visualiza. */
export function isStoreLogin(actor: Actor) {
  return actor.role !== "admin" && hasCompany(actor.companyId);
}

export function storeScope(actor: Actor) {
  return resolveStoreScope(actor, "rma:view");
}

/** Autenticação + permissão + login sem loja + mesma origem (gravações). */
export function writeGuard(request: Request, action: string, message: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!can(actor, action)) return { error: jsonResponse({ error: message }, 403) };
  if (isStoreLogin(actor)) return { error: jsonResponse({ error: "LOGIN DE LOJA SÓ VISUALIZA OS RMAs." }, 403) };
  if (!sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

/** RMA pelo id, só se estiver no escopo de loja do ator (fora = 404). */
export async function findCase(database: Database, actor: Actor, id: string): Promise<CaseRow | null> {
  const row = id
    ? await database
      .prepare("SELECT id, code, store_id AS storeId, status, finalized FROM rma_cases WHERE id=?1 AND deleted=0")
      .bind(id)
      .first<CaseRow>()
    : null;
  return row && canActOnStore(actor, "rma:view", row.storeId) ? row : null;
}

/** Todas as lojas do cadastro (inclui ASSISTÊNCIA, que também manda RMA). */
export async function loadCompanies(database: Database): Promise<{ id: string; name: string }[]> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  try {
    const list = row?.value ? (JSON.parse(row.value) as { id: string; name: string }[]) : [];
    return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string" && typeof item.name === "string") : [];
  } catch {
    return [];
  }
}

export const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function dateOrEmpty(value: unknown) {
  const text = safeText(value, 10);
  return DATE.test(text) ? text : "";
}

export function upper(value: unknown, max: number) {
  return safeText(value, max).toLocaleUpperCase("pt-BR");
}

/**
 * Dono do anexo no escopo do ator → id do RMA ('' para crédito), ou null se
 * não existe/está fora do escopo. Crédito pede rma:finance.
 */
export async function ownerRma(database: Database, actor: Actor, ownerType: string, ownerId: string): Promise<string | null> {
  if (ownerType === "credit") {
    if (!can(actor, "finance")) return null;
    const credit = await database.prepare("SELECT id FROM rma_credits WHERE id=?1 AND deleted=0").bind(ownerId).first<{ id: string }>();
    return credit ? "" : null;
  }
  const rmaId = ownerType === "update"
    ? (await database.prepare("SELECT rma_id AS rmaId FROM rma_updates WHERE id=?1 AND deleted=0").bind(ownerId).first<{ rmaId: string }>())?.rmaId
    : ownerType === "rma" ? ownerId : "";
  return rmaId && (await findCase(database, actor, rmaId)) ? rmaId : null;
}
