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
