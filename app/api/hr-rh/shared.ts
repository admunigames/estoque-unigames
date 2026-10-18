import type { Identity } from "../hr-payroll/shared";

// RH — áreas novas de out/2026 (Painel do RH: dashboard, desligamentos e
// exames a vencer; Onboarding). Cada área tem permissão própria; o RH
// Financeiro (payroll:manage) e o admin podem tudo.

export { actorName, identity, jsonResponse, safeText, sameOrigin, type Identity, type JsonMap } from "../hr-payroll/shared";

export type RhPermission =
  | "rh_dashboard:view"
  | "rh_desligamento:view" | "rh_desligamento:manage"
  | "rh_exames:view"
  | "rh_onboarding:videos" | "rh_onboarding:track";

export function rhCan(actor: Identity, ...permissions: RhPermission[]) {
  return actor.role === "admin" ||
    actor.permissions.includes("payroll:manage") ||
    permissions.some((permission) => actor.permissions.includes(permission));
}
