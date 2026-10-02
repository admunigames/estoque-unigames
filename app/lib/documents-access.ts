// Regras de acesso do módulo Documentos, compartilhadas entre o worker
// (porteiro de /api/documents) e as rotas (checagem fina por ação).
//
// - VISUALIZAR: qualquer usuário logado, exceto login só-Comercial.
// - CADASTRAR / EDITAR / EXCLUIR: admin ou a permissão exata
//   (documents:create, documents:edit, documents:delete), válidas para as
//   três pastas do módulo.

export const DOCUMENT_WRITE_PERMISSIONS = [
  "documents:create",
  "documents:edit",
  "documents:delete",
] as const;

export type DocumentWritePermission = (typeof DOCUMENT_WRITE_PERMISSIONS)[number];

type DocumentAccessUser = {
  role: string;
  permissions: readonly string[];
};

/**
 * Login de vendedor: todas as permissões são do módulo Comercial. Esse
 * usuário vê só Início, Instruções e Comercial — Documentos (liberado para
 * qualquer outro usuário logado) fica escondido para ele (decisão do
 * usuário, 2026-09-30). Mesma regra em isCommercialOnlySession() no front.
 */
export function isCommercialOnlyAccess(user: DocumentAccessUser): boolean {
  return (
    user.role !== "admin" &&
    user.permissions.length > 0 &&
    user.permissions.every((permission) => permission.startsWith("comercial:"))
  );
}

export function hasDocumentPermission(
  user: DocumentAccessUser,
  permission: DocumentWritePermission,
): boolean {
  return user.role === "admin" || user.permissions.includes(permission);
}

/**
 * Porteiro de /api/documents no worker: GET/HEAD para todos (menos
 * só-Comercial); os demais métodos para quem tiver QUALQUER uma das três
 * permissões — a rota decide qual delas a ação exige.
 */
export function documentsApiAllowed(user: DocumentAccessUser, method: string): boolean {
  if (isCommercialOnlyAccess(user)) return false;
  if (method === "GET" || method === "HEAD") return true;
  return DOCUMENT_WRITE_PERMISSIONS.some((permission) => hasDocumentPermission(user, permission));
}
