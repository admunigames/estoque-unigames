import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

const STATUSES = new Set(["available", "loaned", "maintenance"]);

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canAccessLoans(actor: Identity) {
  return actor.role === "admin" || actor.permissions.some((permission) => permission.startsWith("loans:"));
}

function canManageCatalog(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("loans:create") ||
    actor.permissions.includes("loans:edit") ||
    actor.permissions.includes("loans:delete")
  );
}

function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

type DeviceRow = {
  id: string;
  name: string;
  imei: string;
  hasDefect: number;
  defectDescription: string;
  status: string;
  currentCompanyId: string;
  currentCompanyName: string;
  loanedAt: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

const DEVICE_SELECT = `
  SELECT id, name, imei, has_defect AS hasDefect, defect_description AS defectDescription,
         status, current_company_id AS currentCompanyId, current_company_name AS currentCompanyName,
         loaned_at AS loanedAt, created_by_name AS createdByName,
         created_at AS createdAt, updated_at AS updatedAt
  FROM loan_devices`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessLoans(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A APARELHOS DE EMPRÉSTIMO." }, 403);
  }

  try {
    const database = await getD1();
    const query = canManageCatalog(actor)
      ? `${DEVICE_SELECT} ORDER BY name ASC`
      : `${DEVICE_SELECT} WHERE status='available' ORDER BY name ASC`;
    const result = await database.prepare(query).all<DeviceRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os aparelhos de empréstimo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS APARELHOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (actor.role !== "admin" && !actor.permissions.includes("loans:create")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR APARELHOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const name = safeText(body.name, 180).toUpperCase();
    const imei = safeText(body.imei, 60);
    const hasDefect = body.hasDefect === true ? 1 : 0;
    const defectDescription = hasDefect ? safeText(body.defectDescription, 400) : "";
    const status = STATUSES.has(safeText(body.status, 20)) ? safeText(body.status, 20) : "available";

    if (name.length < 2) {
      return jsonResponse({ error: "INFORME O NOME/MODELO DO APARELHO." }, 400);
    }

    const database = await getD1();
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO loan_devices
          (id, name, imei, has_defect, defect_description, status, created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(id, name, imei, hasDefect, defectDescription, status, actor.id, actor.displayName)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar o aparelho de empréstimo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CRIAR O APARELHO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (actor.role !== "admin" && !actor.permissions.includes("loans:edit")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR APARELHOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "APARELHO INVÁLIDO." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM loan_devices WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "APARELHO NÃO ENCONTRADO." }, 404);
    }

    const sets: string[] = [];
    const bindings: (string | number)[] = [];
    let index = 1;

    if (typeof body.name === "string") {
      const name = safeText(body.name, 180).toUpperCase();
      if (name.length < 2) {
        return jsonResponse({ error: "INFORME O NOME/MODELO DO APARELHO." }, 400);
      }
      sets.push(`name=?${index++}`);
      bindings.push(name);
    }
    if (typeof body.imei === "string") {
      sets.push(`imei=?${index++}`);
      bindings.push(safeText(body.imei, 60));
    }
    if (typeof body.hasDefect === "boolean") {
      sets.push(`has_defect=?${index++}`);
      bindings.push(body.hasDefect ? 1 : 0);
      sets.push(`defect_description=?${index++}`);
      bindings.push(body.hasDefect ? safeText(body.defectDescription, 400) : "");
    } else if (typeof body.defectDescription === "string") {
      sets.push(`defect_description=?${index++}`);
      bindings.push(safeText(body.defectDescription, 400));
    }
    if (typeof body.status === "string" && body.status) {
      const status = safeText(body.status, 20);
      if (!STATUSES.has(status)) {
        return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);
      }
      sets.push(`status=?${index++}`);
      bindings.push(status);
      // Voltar manualmente para disponível/manutenção encerra o empréstimo
      // vigente (a devolução física é registrada aqui, na edição do
      // cadastro — não existe um fluxo de "devolver" separado).
      if (status !== "loaned") {
        sets.push(`current_company_id=?${index++}`);
        bindings.push("");
        sets.push(`current_company_name=?${index++}`);
        bindings.push("");
        sets.push(`loaned_at=?${index++}`);
        bindings.push("");
      }
    }

    if (!sets.length) {
      return jsonResponse({ error: "NADA PARA ATUALIZAR." }, 400);
    }
    sets.push(`updated_at=CURRENT_TIMESTAMP`);
    bindings.push(id);

    await database
      .prepare(`UPDATE loan_devices SET ${sets.join(", ")} WHERE id=?${index}`)
      .bind(...bindings)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível atualizar o aparelho de empréstimo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O APARELHO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (actor.role !== "admin" && !actor.permissions.includes("loans:delete")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR APARELHOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "APARELHO INVÁLIDO." }, 400);
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM loan_devices WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "APARELHO NÃO ENCONTRADO." }, 404);
    }
    await database.prepare("DELETE FROM loan_devices WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir o aparelho de empréstimo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O APARELHO." }, 500);
  }
}
