import type { LiveInvalidation } from "./live-updates";

type LiveActor = {
  id: string;
  companyId: string;
};

type JsonMap = Record<string, unknown>;

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonMap
    : {};
}

function safeCompanyId(value: unknown): string {
  return typeof value === "string" && /^c[a-z0-9]{6,40}$/i.test(value)
    ? value
    : "";
}

async function requestBody(request: Request): Promise<JsonMap> {
  try {
    return asRecord(await request.clone().json());
  } catch {
    return {};
  }
}

export async function liveInvalidationForRequest(
  request: Request,
  actor: LiveActor,
): Promise<LiveInvalidation | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return null;
  }

  if (path === "/api/missions" || path === "/api/routines") {
    if (request.method === "POST") {
      const body = await requestBody(request);
      if (body.scope === "general") {
        return { module: "missions", audience: { kind: "all" } };
      }
      const companyId = safeCompanyId(body.companyId);
      return companyId
        ? { module: "missions", audience: { kind: "company", companyId } }
        : null;
    }
    if (request.method === "PATCH") {
      return safeCompanyId(actor.companyId)
        ? {
            module: "missions",
            audience: { kind: "company", companyId: actor.companyId },
          }
        : null;
    }
    if (request.method === "DELETE") {
      // A exclusao administrativa pode atingir uma missao/rotina geral ou de
      // loja. O aviso nao contem dados; cada cliente recarrega pela API segura.
      return { module: "missions", audience: { kind: "all" } };
    }
  }

  if (path === "/api/supplies" || path.startsWith("/api/supplies/")) {
    // Catalogo e estoque fisico afetam a disponibilidade para todas as lojas.
    if (
      path === "/api/supplies/categories" ||
      path === "/api/supplies/products" ||
      path === "/api/supplies/stock"
    ) {
      return { module: "supplies", audience: { kind: "all" } };
    }

    const body = await requestBody(request);
    const companyId = safeCompanyId(body.companyId) || safeCompanyId(actor.companyId);
    if (companyId) {
      return { module: "supplies", audience: { kind: "company", companyId } };
    }

    // Acoes administrativas por id (separar/excluir) nao trazem a loja no
    // pedido. O aviso segue sem dados; cada sessao recarrega pela API filtrada.
    return { module: "supplies", audience: { kind: "all" } };
  }

  if (path === "/api/loans/devices" || path.startsWith("/api/loans/requests")) {
    // Catalogo (cadastrar/editar/excluir aparelho, mudar status) afeta a
    // disponibilidade para todas as lojas.
    if (path === "/api/loans/devices") {
      return { module: "loans", audience: { kind: "all" } };
    }

    const body = await requestBody(request);
    const companyId = safeCompanyId(body.companyId) || safeCompanyId(actor.companyId);
    if (companyId) {
      // "groups" garante que quem gerencia solicitações (permissão
      // loans:manage_requests, não role="admin" literal) também receba o
      // aviso de uma nova solicitação de outra loja — ver liveConnectionGroups
      // em worker/index.ts.
      return { module: "loans", audience: { kind: "company", companyId, groups: ["loans_manage"] } };
    }

    // Acoes administrativas por id (marcar emprestado/devolvido, apagar
    // solicitacao, responder) nao trazem a loja no pedido. O aviso segue
    // sem dados; cada sessao recarrega pela API filtrada.
    return { module: "loans", audience: { kind: "all" } };
  }

  if (path === "/api/shared-state") {
    const body = request.method === "PUT" ? await requestBody(request) : {};
    const key = request.method === "DELETE"
      ? url.searchParams.get("key") ?? ""
      : typeof body.key === "string" ? body.key : "";
    if (/^tarefas:\d{4}-\d{2}-\d{2}$/.test(key)) {
      return { module: "tasks", audience: { kind: "user", userId: actor.id } };
    }
  }

  return null;
}

export function liveInvalidationForResponse(
  request: Request,
  response: Response,
  requestInvalidation: LiveInvalidation | null,
): LiveInvalidation | null {
  if (requestInvalidation) return requestInvalidation;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path !== "/api/captures" || !["POST", "PATCH", "DELETE"].includes(request.method)) {
    return null;
  }

  const companyId = safeCompanyId(response.headers.get("x-unigames-live-company-id"));
  if (!companyId) return null;
  const category = response.headers.get("x-unigames-live-capture-category");
  return {
    module: "captures",
    audience: {
      kind: "company",
      companyId,
      // A Assistencia ve todas as categorias, exceto jogos, na API atual.
      groups: category === "jogo" ? [] : ["assistance"],
    },
  };
}
