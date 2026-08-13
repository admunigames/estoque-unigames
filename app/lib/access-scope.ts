/**
 * Regra única de "esse usuário vê todas as lojas, ou só a própria?",
 * reutilizada por toda rota que hoje filtra dados por `company_id`.
 *
 * Antes disso, cada módulo reimplementava essa decisão à sua maneira —
 * o que fez o mesmo bug aparecer separadamente em Captação e Saídas:
 * um usuário sem loja vinculada (companyId vazio), mesmo com a permissão
 * do módulo concedida no cadastro, recebia "SEU USUÁRIO PRECISA ESTAR
 * VINCULADO A UMA LOJA" e não via nada. A regra correta é: quem já tem
 * loja fica preso a ela (como sempre foi); quem NÃO tem loja só é
 * bloqueado se também não tiver a permissão — do contrário, enxerga e
 * age sobre todas as lojas, do mesmo jeito que um administrador.
 */

export const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;

export type ScopeActor = {
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};

export function hasCompany(companyId: string): boolean {
  return COMPANY_PATTERN.test(companyId);
}

/**
 * `requiredPermission` é a permissão granular da ação sendo feita
 * (ex.: "supplies:view", "missions:complete_any" — o que fizer sentido
 * pro módulo). Um admin sempre vê tudo. Um usuário com loja vinculada
 * sempre fica restrito à própria loja, mesmo tendo a permissão — a
 * permissão só amplia o alcance de quem NÃO tem loja nenhuma.
 */
export function canSeeAllStores(actor: ScopeActor, requiredPermission: string): boolean {
  if (actor.role === "admin") return true;
  if (hasCompany(actor.companyId)) return false;
  return actor.permissions.includes(requiredPermission);
}

/**
 * Atalho para o caso comum: usuário tem acesso (à própria loja ou a
 * todas), ou deve ser bloqueado com a mensagem padrão de "sem loja".
 * Retorna `{ allStores: true }`, `{ allStores: false }` (usa
 * actor.companyId para filtrar), ou `{ blocked: true }`.
 */
export function resolveStoreScope(
  actor: ScopeActor,
  requiredPermission: string,
): { blocked: true } | { blocked: false; allStores: boolean } {
  const allStores = canSeeAllStores(actor, requiredPermission);
  if (allStores) return { blocked: false, allStores: true };
  if (hasCompany(actor.companyId)) return { blocked: false, allStores: false };
  return { blocked: true };
}

export const NO_COMPANY_ERROR = "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA.";
