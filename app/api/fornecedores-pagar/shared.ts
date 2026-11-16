import { unauthorizedResponse } from "../../lib/notion";
import { hasCompany } from "../../lib/access-scope";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";

// Financeiro > Fornecedores a Pagar: permissões fornecedores_pagar:view/
// create/pay/delete; login com loja vinculada não vê nada (só ADM/Financeiro).
export type Actor = ReturnType<typeof identity>;
export { jsonResponse, safeText };

export const ACTIONS = ["view", "create", "pay", "delete"];

export const can = (actor: Actor, action: string) =>
  actor.role === "admin" || actor.permissions.includes(`fornecedores_pagar:${action}`);
export const actorName = (actor: Actor) => actor.displayName || actor.id;

export function guard(request: Request, action: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  const allowed = action === "view" ? ACTIONS.some((item) => can(actor, item)) : can(actor, action);
  if (!allowed || (actor.role !== "admin" && hasCompany(actor.companyId))) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA FORNECEDORES A PAGAR." }, 403) };
  }
  if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
    return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  }
  return { actor };
}
