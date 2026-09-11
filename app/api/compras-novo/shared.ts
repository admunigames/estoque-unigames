import { identity, jsonResponse, safeText, sameOrigin, type Identity, type JsonMap } from "../finance/shared";

export { identity, jsonResponse, safeText, sameOrigin };
export type { Identity, JsonMap };

// Módulo "Compras" nativo (Fase A) — permissão única purchases_draft:manage
// (ver worker/index.ts), independente das permissões purchases:* do
// Controle de Compras (Notion), que não é tocado por este módulo.
export function canManageComprasDraft(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("purchases_draft:manage");
}

export function newId() {
  return crypto.randomUUID();
}

export function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
