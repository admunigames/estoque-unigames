import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};
type InstructionRow = {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

function canManageInstructions(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("instructions:manage");
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

function recifeDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const status = new URL(request.url).searchParams.get("status") === "history"
    ? "history"
    : "active";
  const today = recifeDateKey();

  try {
    const database = await getD1();
    const condition = status === "history" ? "due_date < ?1" : "due_date >= ?1";
    const order = status === "history"
      ? "due_date DESC, created_at DESC"
      : "due_date ASC, created_at DESC";
    const [result, summary] = await Promise.all([
      database
        .prepare(
          `SELECT id, title, description, due_date AS dueDate,
                  created_by AS createdBy, created_by_name AS createdByName,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM instructions
           WHERE ${condition}
           ORDER BY ${order}`,
        )
        .bind(today)
        .all<InstructionRow>(),
      database
        .prepare(
          `SELECT
             SUM(CASE WHEN due_date >= ?1 THEN 1 ELSE 0 END) AS activeCount,
             SUM(CASE WHEN due_date < ?1 THEN 1 ELSE 0 END) AS historyCount,
             MIN(CASE WHEN due_date >= ?1 THEN due_date ELSE NULL END) AS nearestDueDate
           FROM instructions`,
        )
        .bind(today)
        .first<{
          activeCount: number | null;
          historyCount: number | null;
          nearestDueDate: string | null;
        }>(),
    ]);

    return jsonResponse({
      status,
      today,
      instructions: result.results ?? [],
      summary: {
        activeCount: Number(summary?.activeCount ?? 0),
        historyCount: Number(summary?.historyCount ?? 0),
        nearestDueDate: summary?.nearestDueDate ?? "",
      },
    });
  } catch (error) {
    console.error("Não foi possível carregar as instruções.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS INSTRUÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageInstructions(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR INSTRUÇÕES." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const title = safeText(body.title, 160);
    const description = safeText(body.description, 3000);
    const dueDate = safeText(body.dueDate, 10);
    if (title.length < 3) {
      return jsonResponse({ error: "INFORME O TÍTULO DA INSTRUÇÃO." }, 400);
    }
    if (description.length < 3) {
      return jsonResponse({ error: "DESCREVA A INSTRUÇÃO PARA AS LOJAS." }, 400);
    }
    if (!DATE_PATTERN.test(dueDate)) {
      return jsonResponse({ error: "INFORME UM PRAZO VÁLIDO." }, 400);
    }
    if (dueDate < recifeDateKey()) {
      return jsonResponse(
        { error: "O PRAZO NÃO PODE SER ANTERIOR À DATA DE HOJE." },
        400,
      );
    }

    const database = await getD1();
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO instructions
          (id, title, description, due_date, created_by, created_by_name,
           created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        title,
        description,
        dueDate,
        actor.id,
        actor.displayName || "Administrador",
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a instrução.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A INSTRUÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageInstructions(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR INSTRUÇÕES." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "INSTRUÇÃO INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    await database.prepare("DELETE FROM instructions WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a instrução.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A INSTRUÇÃO." }, 500);
  }
}
