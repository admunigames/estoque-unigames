import webPush from "web-push";
import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type RoutineStatus = "todo" | "in_progress" | "completed";
type RoutineDefinitionRow = {
  id: string;
  title: string;
  description: string;
  weekday: number;
  scope: "general" | "store";
  companyId: string;
  companyName: string;
  active: number;
  createdBy: string;
  createdByName: string;
};
type RoutineTaskRow = {
  id: string;
  routineId: string;
  companyId: string;
  companyName: string;
  originDate: string;
  dueDate: string;
  status: RoutineStatus;
  carriedOver: number;
  title?: string;
  description?: string;
  weekday?: number;
  scope?: "general" | "store";
  createdBy?: string;
};
type CompanyRecord = { id: string; name: string };
type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;
const ROUTINE_STATUSES = new Set<RoutineStatus>(["todo", "in_progress", "completed"]);

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

function routineStatus(value: unknown): RoutineStatus | null {
  return typeof value === "string" && ROUTINE_STATUSES.has(value as RoutineStatus)
    ? (value as RoutineStatus)
    : null;
}

function routineWeekday(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 6 ? parsed : null;
}

function recifeDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dateWeekday(dateKey: string) {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
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
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function can(actor: Identity, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
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

const DIACRITICS_PATTERN = new RegExp(
  "[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]",
  "g",
);

// Depósito e Assistência são setores internos, não lojas — não recebem rotinas gerais.
function isNonStoreCompany(name: string) {
  const normalized = name.toLowerCase().normalize("NFD").replace(DIACRITICS_PATTERN, "").trim();
  if (/\bassistencia\b/.test(normalized) || normalized.includes("assistance")) return true;
  if (
    /\bdeposito\b/.test(normalized) ||
    normalized === "cd" ||
    normalized.startsWith("cd ") ||
    normalized.includes("centro de distribuicao")
  ) {
    return true;
  }
  return false;
}

async function storeCompanies(database: D1Database): Promise<CompanyRecord[]> {
  try {
    const row = await database
      .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
      .first<{ value: string }>();
    const parsed = row?.value ? JSON.parse(row.value) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CompanyRecord =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        !isNonStoreCompany(item.name),
    );
  } catch {
    return [];
  }
}

async function companyName(database: D1Database, companyId: string) {
  const companies = await storeCompanies(database);
  return companies.find((company) => company.id === companyId)?.name || "";
}

async function generateTodayTasks(
  database: D1Database,
  routine: { id: string; scope: string; companyId: string; companyName: string },
  today: string,
) {
  const targets: CompanyRecord[] =
    routine.scope === "general"
      ? await storeCompanies(database)
      : [{ id: routine.companyId, name: routine.companyName }];
  for (const target of targets) {
    if (!target.id) continue;
    await database
      .prepare(
        `INSERT INTO operational_routine_tasks
          (id, routine_id, company_id, company_name, origin_date, due_date, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'todo', CURRENT_TIMESTAMP)
         ON CONFLICT (routine_id, origin_date, company_id) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), routine.id, target.id, target.name, today)
      .run();
  }
}

async function notifyRoutineCreator(
  database: D1Database,
  routine: { title: string; createdBy: string },
  completedByStore: string,
) {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || "";
  const subject = process.env.VAPID_SUBJECT?.trim() || "";
  if (!publicKey || !privateKey || !subject || !routine.createdBy) return;

  const subscriptions = await database
    .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?1")
    .bind(routine.createdBy)
    .all<PushSubscriptionRow>();
  if (!(subscriptions.results ?? []).length) return;

  webPush.setVapidDetails(subject, publicKey, privateKey);
  for (const subscription of subscriptions.results ?? []) {
    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify({
          title: `Rotina concluída — ${completedByStore}`,
          body: routine.title,
          url: "/missoes",
          tag: `unigames-routine-complete-${routine.title}-${completedByStore}`,
        }),
        { TTL: 60 * 60 * 12, urgency: "high" },
      );
    } catch (error) {
      const statusCode =
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : 0;
      if (statusCode === 404 || statusCode === 410) {
        await database.prepare("DELETE FROM push_subscriptions WHERE id=?1").bind(subscription.id).run();
      } else {
        console.error("Falha ao avisar o administrador sobre a rotina.", error);
      }
    }
  }
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const url = new URL(request.url);
  const date = (url.searchParams.get("date") || "").trim();
  if (!DATE_PATTERN.test(date)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);

  try {
    const database = await getD1();

    const taskResult = await database
      .prepare(
        `SELECT t.id, t.routine_id AS routineId, t.company_id AS companyId,
                t.company_name AS companyName, t.origin_date AS originDate,
                t.due_date AS dueDate, t.status, t.carried_over AS carriedOver,
                r.title, r.description, r.weekday, r.scope, r.created_by AS createdBy
         FROM operational_routine_tasks t
         JOIN operational_routines r ON r.id = t.routine_id
         WHERE t.due_date = ?1
         ORDER BY t.updated_at DESC, t.created_at DESC`,
      )
      .bind(date)
      .all<RoutineTaskRow>();

    let tasks = taskResult.results ?? [];
    if (actor.role !== "admin") {
      tasks = actor.companyId ? tasks.filter((task) => task.companyId === actor.companyId) : [];
    }

    const payload: JsonMap = {
      date,
      tasks: tasks.map((task) => ({ ...task, completed: task.status === "completed" })),
    };

    if (can(actor, "missions:create") || can(actor, "missions:delete")) {
      const definitionsResult = await database
        .prepare(
          `SELECT id, title, description, weekday, scope, company_id AS companyId,
                  company_name AS companyName, active, created_by AS createdBy,
                  created_by_name AS createdByName
           FROM operational_routines
           ORDER BY weekday, created_at`,
        )
        .all<RoutineDefinitionRow>();
      payload.routines = definitionsResult.results ?? [];
    }

    return jsonResponse(payload);
  } catch (error) {
    console.error("Não foi possível carregar a rotina operacional.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A ROTINA OPERACIONAL." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "missions:create")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CRIAR ROTINAS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const title = safeText(body.title, 160);
    const description = safeText(body.description, 1200);
    const scope = body.scope === "general" ? "general" : "store";
    const weekday = routineWeekday(body.weekday);
    const companyId = scope === "store" ? safeText(body.companyId, 80) : "";
    const companyLabel = scope === "store" ? safeText(body.companyName, 120) : "Todas as lojas";
    if (title.length < 3) return jsonResponse({ error: "INFORME O TÍTULO DA ROTINA." }, 400);
    if (weekday === null) return jsonResponse({ error: "ESCOLHA O DIA DA SEMANA DA ROTINA." }, 400);
    if (scope === "store" && !COMPANY_PATTERN.test(companyId)) {
      return jsonResponse({ error: "ESCOLHA A LOJA DA ROTINA." }, 400);
    }

    const database = await getD1();
    const trustedCompanyName =
      scope === "store" ? (await companyName(database, companyId)) || companyLabel || "Loja" : "Todas as lojas";
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO operational_routines
          (id, title, description, weekday, scope, company_id, company_name,
           created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(id, title, description, weekday, scope, companyId, trustedCompanyName, actor.id, actor.displayName || "Administrador")
      .run();

    const todayKey = recifeDateKey();
    if (dateWeekday(todayKey) === weekday) {
      await generateTodayTasks(database, { id, scope, companyId, companyName: trustedCompanyName }, todayKey);
    }

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a rotina operacional.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A ROTINA." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  if (actor.role === "admin") {
    return jsonResponse({ error: "O ADMINISTRADOR NÃO PODE ALTERAR O STATUS DAS ROTINAS." }, 403);
  }
  if (!actor.id || !COMPANY_PATTERN.test(actor.companyId)) {
    return jsonResponse({ error: "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const taskId = safeText(body.taskId, 80);
    const status = routineStatus(body.status);
    if (!taskId) return jsonResponse({ error: "TAREFA INVÁLIDA." }, 400);
    if (!status) return jsonResponse({ error: "ESCOLHA: CONCLUÍDO, EM ANDAMENTO OU A FAZER." }, 400);

    const database = await getD1();
    const task = await database
      .prepare(
        `SELECT t.id, t.routine_id AS routineId, t.company_id AS companyId, t.status,
                r.title, r.created_by AS createdBy
         FROM operational_routine_tasks t
         JOIN operational_routines r ON r.id = t.routine_id
         WHERE t.id=?1 LIMIT 1`,
      )
      .bind(taskId)
      .first<{ id: string; routineId: string; companyId: string; status: RoutineStatus; title: string; createdBy: string }>();
    if (!task) return jsonResponse({ error: "TAREFA NÃO ENCONTRADA." }, 404);
    if (task.companyId !== actor.companyId) {
      return jsonResponse({ error: "ESTA TAREFA PERTENCE A OUTRA LOJA." }, 403);
    }

    await database
      .prepare(
        `UPDATE operational_routine_tasks SET
           status=?1, completed_by=?2, completed_by_name=?3,
           completed_at=CASE WHEN ?1='completed' THEN CURRENT_TIMESTAMP ELSE '' END,
           updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
      )
      .bind(status, status === "completed" ? actor.id : "", status === "completed" ? actor.displayName : "", taskId)
      .run();

    if (status === "completed" && task.status !== "completed") {
      const storeName = (await companyName(database, actor.companyId)) || "Loja";
      await notifyRoutineCreator(database, { title: task.title, createdBy: task.createdBy }, storeName);
    }

    return jsonResponse({ status, completed: status === "completed" });
  } catch (error) {
    console.error("Não foi possível concluir a rotina.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A ROTINA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "missions:delete")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR ROTINAS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: "ROTINA INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    await database.batch([
      database.prepare("DELETE FROM operational_routine_tasks WHERE routine_id=?1").bind(id),
      database.prepare("DELETE FROM operational_routines WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a rotina.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A ROTINA." }, 500);
  }
}
