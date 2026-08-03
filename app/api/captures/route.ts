import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;
type CaptureStatus = "submitted" | "received" | "ready" | "assigned";
type CaptureCategory = "console" | "controller" | "other";
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  accessGroup: string;
  companyId: string;
  permissions: string[];
};
type CaptureRow = {
  id: string;
  category: CaptureCategory;
  productName: string;
  serialNumber: string;
  defects: string;
  color: string;
  originCompanyId: string;
  originCompanyName: string;
  status: CaptureStatus;
  destinationCompanyId: string;
  destinationCompanyName: string;
  createdBy: string;
  createdByName: string;
  receivedBy: string;
  receivedByName: string;
  receivedAt: string;
  readyBy: string;
  readyByName: string;
  readyAt: string;
  assignedBy: string;
  assignedByName: string;
  assignedAt: string;
  createdAt: string;
  updatedAt: string;
};

const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;
const CAPTURE_STATUSES = new Set<CaptureStatus>([
  "submitted",
  "received",
  "ready",
  "assigned",
]);

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
    accessGroup: safeText(request.headers.get("x-unigames-access-group"), 40),
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canAccessCaptures(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("captures");
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

async function companyName(database: D1Database, companyId: string) {
  try {
    const row = await database
      .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
      .first<{ value: string }>();
    const parsed = row?.value ? JSON.parse(row.value) : [];
    if (!Array.isArray(parsed)) return "";
    const company = parsed.find(
      (item): item is { id: string; name: string } =>
        Boolean(item) &&
        typeof item === "object" &&
        "id" in item &&
        item.id === companyId &&
        "name" in item &&
        typeof item.name === "string",
    );
    return company?.name?.trim().slice(0, 120) || "";
  } catch {
    return "";
  }
}

const CAPTURE_SELECT = `
  SELECT id, category, product_name AS productName,
         serial_number AS serialNumber, defects, color,
         origin_company_id AS originCompanyId,
         origin_company_name AS originCompanyName, status,
         destination_company_id AS destinationCompanyId,
         destination_company_name AS destinationCompanyName,
         created_by AS createdBy, created_by_name AS createdByName,
         received_by AS receivedBy, received_by_name AS receivedByName,
         received_at AS receivedAt, ready_by AS readyBy,
         ready_by_name AS readyByName, ready_at AS readyAt,
         assigned_by AS assignedBy, assigned_by_name AS assignedByName,
         assigned_at AS assignedAt, created_at AS createdAt,
         updated_at AS updatedAt
  FROM captured_products`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
  }

  try {
    const database = await getD1();
    const allStores =
      actor.role === "admin" || actor.accessGroup === "assistance";
    if (!allStores && !COMPANY_PATTERN.test(actor.companyId)) {
      return jsonResponse(
        { error: "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA." },
        403,
      );
    }
    const result = allStores
      ? await database
          .prepare(
            `${CAPTURE_SELECT}
             ORDER BY CASE status
               WHEN 'ready' THEN 0 WHEN 'submitted' THEN 1
               WHEN 'received' THEN 2 ELSE 3 END,
               updated_at DESC`,
          )
          .all<CaptureRow>()
      : await database
          .prepare(
            `${CAPTURE_SELECT}
             WHERE origin_company_id=?1
             ORDER BY updated_at DESC`,
          )
          .bind(actor.companyId)
          .all<CaptureRow>();

    const requestedStatus = safeText(
      new URL(request.url).searchParams.get("status"),
      30,
    ) as CaptureStatus;
    const rows = result.results ?? [];
    return jsonResponse({
      captures: CAPTURE_STATUSES.has(requestedStatus)
        ? rows.filter((row) => row.status === requestedStatus)
        : rows,
    });
  } catch (error) {
    console.error("Não foi possível carregar as captações.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CAPTAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  if (
    actor.role === "admin" ||
    actor.accessGroup === "assistance" ||
    !COMPANY_PATTERN.test(actor.companyId)
  ) {
    return jsonResponse(
      { error: "O CADASTRO DE PRODUTOS DEVE SER FEITO POR UM USUÁRIO VINCULADO À LOJA." },
      403,
    );
  }

  try {
    const body = (await request.json()) as JsonMap;
    const category: CaptureCategory =
      body.category === "console" || body.category === "controller"
        ? body.category
        : "other";
    const productName = safeText(body.productName, 160);
    const serialNumber = safeText(body.serialNumber, 160);
    const defects = safeText(body.defects, 1200);
    const color = safeText(body.color, 120);
    if (productName.length < 2) {
      return jsonResponse({ error: "INFORME O PRODUTO OU MODELO." }, 400);
    }
    if (!serialNumber) {
      return jsonResponse({ error: "INFORME O SERIAL DO PRODUTO." }, 400);
    }
    if (!defects) {
      return jsonResponse({ error: "INFORME OS DEFEITOS OU ESCREVA “SEM DEFEITO”." }, 400);
    }
    if (!color) return jsonResponse({ error: "INFORME A COR DO PRODUTO." }, 400);

    const database = await getD1();
    const originCompanyName =
      (await companyName(database, actor.companyId)) || "Loja";
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO captured_products
          (id, category, product_name, serial_number, defects, color,
           origin_company_id, origin_company_name, status,
           created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'submitted',
                 ?9, ?10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        category,
        productName,
        serialNumber,
        defects,
        color,
        actor.companyId,
        originCompanyName,
        actor.id,
        actor.displayName,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o produto captado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O PRODUTO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const action = safeText(body.action, 40);
    if (!id) return jsonResponse({ error: "PRODUTO INVÁLIDO." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare(`${CAPTURE_SELECT} WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<CaptureRow>();
    if (!existing) return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);

    if (action === "receive" || action === "ready") {
      if (actor.accessGroup !== "assistance" || actor.role === "admin") {
        return jsonResponse(
          { error: "SOMENTE A ASSISTÊNCIA PODE ALTERAR ESTA ETAPA." },
          403,
        );
      }
      if (action === "receive" && existing.status !== "submitted") {
        return jsonResponse(
          { error: "O PRODUTO PRECISA ESTAR AGUARDANDO A ASSISTÊNCIA." },
          409,
        );
      }
      if (action === "ready" && existing.status !== "received") {
        return jsonResponse(
          { error: "O PRODUTO PRECISA SER MARCADO COMO RECEBIDO PRIMEIRO." },
          409,
        );
      }
      if (action === "receive") {
        await database
          .prepare(
            `UPDATE captured_products
             SET status='received', received_by=?1, received_by_name=?2,
                 received_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
             WHERE id=?3`,
          )
          .bind(actor.id, actor.displayName, id)
          .run();
      } else {
        await database
          .prepare(
            `UPDATE captured_products
             SET status='ready', ready_by=?1, ready_by_name=?2,
                 ready_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
             WHERE id=?3`,
          )
          .bind(actor.id, actor.displayName, id)
          .run();
      }
      return jsonResponse({
        updated: true,
        status: action === "receive" ? "received" : "ready",
      });
    }

    if (action === "assign") {
      if (actor.role !== "admin") {
        return jsonResponse(
          { error: "SOMENTE O ADMINISTRADOR PODE DEFINIR O DESTINO." },
          403,
        );
      }
      if (existing.status !== "ready") {
        return jsonResponse(
          { error: "O PRODUTO AINDA NÃO ESTÁ DISPONÍVEL PARA SEPARAÇÃO." },
          409,
        );
      }
      const destinationCompanyId = safeText(body.destinationCompanyId, 80);
      if (!COMPANY_PATTERN.test(destinationCompanyId)) {
        return jsonResponse({ error: "ESCOLHA A LOJA DE DESTINO." }, 400);
      }
      const destinationCompanyName = await companyName(
        database,
        destinationCompanyId,
      );
      if (!destinationCompanyName) {
        return jsonResponse({ error: "LOJA DE DESTINO NÃO ENCONTRADA." }, 400);
      }
      await database
        .prepare(
          `UPDATE captured_products
           SET status='assigned', destination_company_id=?1,
               destination_company_name=?2, assigned_by=?3,
               assigned_by_name=?4, assigned_at=CURRENT_TIMESTAMP,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=?5`,
        )
        .bind(
          destinationCompanyId,
          destinationCompanyName,
          actor.id,
          actor.displayName,
          id,
        )
        .run();
      return jsonResponse({
        updated: true,
        status: "assigned",
        destinationCompanyId,
        destinationCompanyName,
      });
    }

    return jsonResponse({ error: "AÇÃO DE CAPTAÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível atualizar a captação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A CAPTAÇÃO." }, 500);
  }
}
