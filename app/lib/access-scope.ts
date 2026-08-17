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

/**
 * Assistência é um setor, não uma loja — não deve existir em
 * Cadastros > Lojas nem aparecer nos seletores de loja de outros
 * módulos (Relatório 41, Puxadas, Estoque Fiscal etc.), que listam a
 * partir de shared_state.companies_list. O fluxo de Insumos, porém, é
 * organizado por company_id (uma solicitação semanal por unidade), e
 * a Assistência precisa da própria solicitação, separada das lojas
 * reais. Em vez de tocar na tabela/lista de lojas, usamos um
 * company_id sintético reservado, só dentro das tabelas de Insumos —
 * ele nunca é gravado em companies_list, então não vaza pra nenhum
 * outro módulo.
 */
export const ASSISTANCE_SUPPLIES_COMPANY_ID = "cassistencia";
export const ASSISTANCE_SUPPLIES_COMPANY_NAME = "ASSISTÊNCIA";

export type SectorScopeActor = ScopeActor & { sector: string };

/**
 * Company_id que o ator deve usar/enxergar no fluxo de Insumos.
 * Assistência sempre usa a própria unidade fixa — nunca "vê todas as
 * lojas", mesmo se ganhar a permissão de alcance geral (diferente do
 * usuário comum sem loja, que canSeeAllStores() trata como admin).
 * Os demais casos seguem a regra genérica normalmente.
 */
export function suppliesActingCompanyId(
  actor: SectorScopeActor,
  requiredPermission: string,
  requestedCompanyId: string,
): string {
  if (actor.role !== "admin" && actor.sector === "assistance") {
    return ASSISTANCE_SUPPLIES_COMPANY_ID;
  }
  if (canSeeAllStores(actor, requiredPermission)) {
    return hasCompany(requestedCompanyId) ? requestedCompanyId : "";
  }
  return actor.companyId;
}
