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
type MissionRow = {
  id: string;
  title: string;
  description: string;
  scope: "general" | "store";
  companyId: string;
  companyName: string;
  frequency: "once" | "daily" | "weekly";
  startDate: string;
  dueTime: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};
type CompletionRow = {
  id: string;
  missionId: string;
  occurrenceDate: string;
  companyId: string;
  companyName: string;
  completedBy: string;
  completedByName: string;
  completedAt: string;
  status: MissionStatus;
  updatedAt: string;
};
type MissionStatus = "todo" | "in_progress" | "completed";
type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;
const MISSION_STATUSES = new Set<MissionStatus>([
  "todo",
  "in_progress",
  "completed",
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

function missionStatus(value: unknown): MissionStatus | null {
  return typeof value === "string" && MISSION_STATUSES.has(value as MissionStatus)
    ? (value as MissionStatus)
    : null;
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

// Quem cadastra missão cadastra para as lojas cumprirem — só quem tem loja
// vinculada é "destinatário" (marca status). Admin e usuários sem loja
// (acessos personalizados) são sempre espectadores: veem o status de cada
// loja, mas a missão nunca vira uma tarefa pessoal deles.
function isMissionViewer(actor: Identity) {
  return actor.role === "admin" || !actor.companyId;
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

function dateAtUtc(value: string) {
  return new Date(`${value}T12:00:00Z`);
}

function missionOccursOn(mission: MissionRow, date: string) {
  if (!DATE_PATTERN.test(date) || mission.startDate > date) return false;
  if (mission.frequency === "daily") {
    const weekday = dateAtUtc(date).getUTCDay();
    return weekday >= 1 && weekday <= 5;
  }
  if (mission.frequency === "once") return mission.startDate === date;
  return dateAtUtc(mission.startDate).getUTCDay() === dateAtUtc(date).getUTCDay();
}

function dateKeysBetween(from: string, to: string) {
  const start = dateAtUtc(from);
  const end = dateAtUtc(to);
  const dates: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function missionsForDate(
  missions: MissionRow[],
  completions: CompletionRow[],
  date: string,
  actor: Identity,
  view: string,
  selectedCompanyId: string,
) {
  let visible = missions.filter((mission) => missionOccursOn(mission, date));
  if (actor.role !== "admin") {
    // Usuários sem loja vinculada (acessos personalizados, ex.: missions:view
    // sem companyId) ainda enxergam as missões gerais e as que criaram — só
    // não têm como ver/comparar contra missões de uma loja específica.
    visible = visible.filter((mission) =>
      view === "general"
        ? mission.scope === "general"
        : view === "store"
          ? Boolean(actor.companyId) && mission.scope === "store" && mission.companyId === actor.companyId
          : mission.scope === "general" ||
            (Boolean(actor.companyId) && mission.companyId === actor.companyId) ||
            mission.createdBy === actor.id,
    );
  } else if (view === "general") {
    visible = visible.filter((mission) => mission.scope === "general");
  } else if (view === "store") {
    visible = visible.filter(
      (mission) =>
        mission.scope === "store" &&
        COMPANY_PATTERN.test(selectedCompanyId) &&
        mission.companyId === selectedCompanyId,
    );
  }

  const missionIds = new Set(visible.map((mission) => mission.id));
  const dayCompletions = completions.filter(
    (completion) =>
      completion.occurrenceDate === date &&
      missionIds.has(completion.missionId) &&
      (isMissionViewer(actor) || completion.companyId === actor.companyId),
  );
  return visible.map((mission) => {
    const missionCompletions = dayCompletions.filter(
      (completion) => completion.missionId === mission.id,
    );
    const recipientStatus =
      missionCompletions.find((completion) => completion.companyId === actor.companyId)?.status ??
      "todo";
    return {
      ...mission,
      status: recipientStatus,
      completed: recipientStatus === "completed",
      completions: isMissionViewer(actor) ? missionCompletions : [],
      completionCount: missionCompletions.filter((completion) => completion.status === "completed").length,
      inProgressCount: missionCompletions.filter((completion) => completion.status === "in_progress").length,
    };
  });
}

async function missionRangeResponse(
  database: D1Database,
  from: string,
  to: string,
  actor: Identity,
  view: string,
  selectedCompanyId: string,
) {
  const dates = dateKeysBetween(from, to);
  if (dates.length > 62) return jsonResponse({ error: "O INTERVALO PODE TER NO MÃXIMO 62 DIAS." }, 400);
  const missionResult = await database
    .prepare(
      `SELECT id, title, description, scope, company_id AS companyId,
              company_name AS companyName, frequency, start_date AS startDate,
              due_time AS dueTime, created_by AS createdBy,
              created_by_name AS createdByName, created_at AS createdAt,
              updated_at AS updatedAt
       FROM missions WHERE start_date <= ?1
       ORDER BY CASE WHEN due_time='' THEN 1 ELSE 0 END, due_time, created_at`,
    )
    .bind(to)
    .all<MissionRow>();
  const completionResult = await database
    .prepare(
      `SELECT id, mission_id AS missionId, occurrence_date AS occurrenceDate,
              company_id AS companyId, company_name AS companyName,
              completed_by AS completedBy, completed_by_name AS completedByName,
              completed_at AS completedAt, status,
              updated_at AS updatedAt
       FROM mission_completions WHERE occurrence_date BETWEEN ?1 AND ?2
       ORDER BY updated_at DESC`,
    )
    .bind(from, to)
    .all<CompletionRow>();
  const missions = missionResult.results ?? [];
  const completions = completionResult.results ?? [];
  return jsonResponse({
    from,
    to,
    days: dates.map((date) => ({
      date,
      missions: missionsForDate(missions, completions, date, actor, view, selectedCompanyId),
    })),
  });
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

async function notifyMissionCreator(
  database: D1Database,
  mission: MissionRow,
  completedByStore: string,
) {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || "";
  const subject = process.env.VAPID_SUBJECT?.trim() || "";
  if (!publicKey || !privateKey || !subject || !mission.createdBy) return;

  const subscriptions = await database
    .prepare(
      `SELECT id, endpoint, p256dh, auth
       FROM push_subscriptions WHERE user_id=?1`,
    )
    .bind(mission.createdBy)
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
          title: `Missão concluída — ${completedByStore}`,
          body: mission.title,
          url: "/missoes",
          tag: `unigames-mission-complete-${mission.id}-${completedByStore}`,
        }),
        { TTL: 60 * 60 * 12, urgency: "high" },
      );
    } catch (error) {
      const statusCode =
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : 0;
      if (statusCode === 404 || statusCode === 410) {
        await database
          .prepare("DELETE FROM push_subscriptions WHERE id=?1")
          .bind(subscription.id)
          .run();
      } else {
        console.error("Falha ao avisar o administrador sobre a missão.", error);
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
  const view = (url.searchParams.get("view") || "dashboard").trim();
  const selectedCompanyId = (url.searchParams.get("companyId") || "").trim();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const rangeRequested = Boolean(from || to);
  if (rangeRequested && (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to) || from > to)) {
    return jsonResponse({ error: "INTERVALO DE DATAS INVALIDO." }, 400);
  }
  if (rangeRequested && !date) {
    try {
      return missionRangeResponse(await getD1(), from, to, actor, view, selectedCompanyId);
    } catch {
      return jsonResponse({ error: "NÃƒO FOI POSSÃVEL CARREGAR AS MISSÃ•ES." }, 500);
    }
  }
  if (rangeRequested && (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to) || from > to)) {
    return jsonResponse({ error: "INTERVALO DE DATAS INVÃLIDO." }, 400);
  }
  if (rangeRequested && date) return jsonResponse({ error: "USE DATA OU INTERVALO, NÃƒO OS DOIS." }, 400);
  if (!DATE_PATTERN.test(date)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    if (rangeRequested) return missionRangeResponse(database, from, to, actor, view, selectedCompanyId);
    const result = await database
      .prepare(
        `SELECT id, title, description, scope, company_id AS companyId,
                company_name AS companyName, frequency, start_date AS startDate,
                due_time AS dueTime, created_by AS createdBy,
                created_by_name AS createdByName, created_at AS createdAt,
                updated_at AS updatedAt
         FROM missions
         WHERE start_date <= ?1
         ORDER BY CASE WHEN due_time='' THEN 1 ELSE 0 END, due_time, created_at`,
      )
      .bind(date)
      .all<MissionRow>();

    let missions = (result.results ?? []).filter((mission) => missionOccursOn(mission, date));
    if (actor.role !== "admin") {
      // Usuários sem loja vinculada (acessos personalizados, ex.: missions:view
      // sem companyId) ainda enxergam as missões gerais e as que criaram — só
      // não têm como ver/comparar contra missões de uma loja específica.
      missions = missions.filter((mission) => {
        if (view === "general") return mission.scope === "general";
        if (view === "store") {
          return Boolean(actor.companyId) && mission.scope === "store" && mission.companyId === actor.companyId;
        }
        return (
          mission.scope === "general" ||
          (Boolean(actor.companyId) && mission.companyId === actor.companyId) ||
          mission.createdBy === actor.id
        );
      });
    } else if (view === "general") {
      missions = missions.filter((mission) => mission.scope === "general");
    } else if (view === "store") {
      missions = missions.filter(
        (mission) =>
          mission.scope === "store" &&
          COMPANY_PATTERN.test(selectedCompanyId) &&
          mission.companyId === selectedCompanyId,
      );
    }

    const completionResult = await database
      .prepare(
        `SELECT id, mission_id AS missionId, occurrence_date AS occurrenceDate,
                company_id AS companyId, company_name AS companyName,
                completed_by AS completedBy, completed_by_name AS completedByName,
                completed_at AS completedAt, status,
                updated_at AS updatedAt
         FROM mission_completions WHERE occurrence_date=?1
         ORDER BY updated_at DESC`,
      )
      .bind(date)
      .all<CompletionRow>();
    const missionIds = new Set(missions.map((mission) => mission.id));
    const completions = (completionResult.results ?? []).filter(
      (completion) =>
        missionIds.has(completion.missionId) &&
        (isMissionViewer(actor) || completion.companyId === actor.companyId),
    );

    return jsonResponse({
      date,
      missions: missions.map((mission) => {
        const missionCompletions = completions.filter(
          (completion) => completion.missionId === mission.id,
        );
        const recipientStatus =
          missionCompletions.find(
            (completion) => completion.companyId === actor.companyId,
          )?.status ?? "todo";
        return {
          ...mission,
          status: recipientStatus,
          completed: recipientStatus === "completed",
          completions: isMissionViewer(actor) ? missionCompletions : [],
          completionCount: missionCompletions.filter(
            (completion) => completion.status === "completed",
          ).length,
          inProgressCount: missionCompletions.filter(
            (completion) => completion.status === "in_progress",
          ).length,
        };
      }),
    });
  } catch (error) {
    console.error("Não foi possível carregar as missões.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS MISSÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "missions:create")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CRIAR MISSÕES." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const title = safeText(body.title, 160);
    const description = safeText(body.description, 1200);
    const scope = body.scope === "general" ? "general" : "store";
    const companyId = scope === "store" ? safeText(body.companyId, 80) : "";
    const companyLabel = scope === "store"
      ? safeText(body.companyName, 120)
      : "Todas as lojas";
    const frequency =
      body.frequency === "daily" || body.frequency === "weekly"
        ? body.frequency
        : "once";
    const startDate = safeText(body.startDate, 10);
    const dueTime = safeText(body.dueTime, 5);
    if (title.length < 3) return jsonResponse({ error: "INFORME O TÍTULO DA MISSÃO." }, 400);
    if (!DATE_PATTERN.test(startDate)) return jsonResponse({ error: "INFORME UMA DATA VÁLIDA." }, 400);
    if (dueTime && !TIME_PATTERN.test(dueTime)) return jsonResponse({ error: "HORÁRIO LIMITE INVÁLIDO." }, 400);
    if (scope === "store" && !COMPANY_PATTERN.test(companyId)) {
      return jsonResponse({ error: "ESCOLHA A LOJA DA MISSÃO." }, 400);
    }

    const database = await getD1();
    const trustedCompanyName =
      scope === "store"
        ? (await companyName(database, companyId)) || companyLabel || "Loja"
        : "Todas as lojas";
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO missions
          (id, title, description, scope, company_id, company_name, frequency,
           start_date, due_time, created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        title,
        description,
        scope,
        companyId,
        trustedCompanyName,
        frequency,
        startDate,
        dueTime,
        actor.id,
        actor.displayName || "Administrador",
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a missão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A MISSÃO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  if (actor.role === "admin") {
    return jsonResponse(
      { error: "O ADMINISTRADOR NÃO PODE ALTERAR O STATUS DAS MISSÕES." },
      403,
    );
  }
  if (!actor.id || !COMPANY_PATTERN.test(actor.companyId)) {
    return jsonResponse({ error: "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const missionId = safeText(body.missionId, 80);
    const occurrenceDate = safeText(body.date, 10);
    const status =
      missionStatus(body.status) ??
      (body.completed === true
        ? "completed"
        : body.completed === false
          ? "todo"
          : null);
    if (!missionId || !DATE_PATTERN.test(occurrenceDate)) {
      return jsonResponse({ error: "MISSÃO OU DATA INVÁLIDA." }, 400);
    }
    if (!status) {
      return jsonResponse(
        { error: "ESCOLHA: CONCLUÍDO, EM ANDAMENTO OU A FAZER." },
        400,
      );
    }
    const database = await getD1();
    const mission = await database
      .prepare(
        `SELECT id, title, description, scope, company_id AS companyId,
                company_name AS companyName, frequency, start_date AS startDate,
                due_time AS dueTime, created_by AS createdBy,
                created_by_name AS createdByName, created_at AS createdAt,
                updated_at AS updatedAt
         FROM missions WHERE id=?1 LIMIT 1`,
      )
      .bind(missionId)
      .first<MissionRow>();
    if (!mission || !missionOccursOn(mission, occurrenceDate)) {
      return jsonResponse({ error: "MISSÃO NÃO ENCONTRADA PARA ESTA DATA." }, 404);
    }
    if (mission.scope === "store" && mission.companyId !== actor.companyId) {
      return jsonResponse({ error: "ESTA MISSÃO PERTENCE A OUTRA LOJA." }, 403);
    }

    const existing = await database
      .prepare(
        `SELECT id, status FROM mission_completions
         WHERE mission_id=?1 AND occurrence_date=?2 AND company_id=?3 LIMIT 1`,
      )
      .bind(missionId, occurrenceDate, actor.companyId)
      .first<{ id: string; status: MissionStatus }>();
    if (status === "todo") {
      if (existing) {
        await database
          .prepare("DELETE FROM mission_completions WHERE id=?1")
          .bind(existing.id)
          .run();
      }
      return jsonResponse({ status, completed: false });
    }

    const storeName =
      (await companyName(database, actor.companyId)) ||
      mission.companyName ||
      "Loja";
    await database
      .prepare(
        `INSERT INTO mission_completions
          (id, mission_id, occurrence_date, company_id, company_name,
           completed_by, completed_by_name, completed_at, status, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?8, CURRENT_TIMESTAMP)
         ON CONFLICT(mission_id, occurrence_date, company_id) DO UPDATE SET
           company_name=excluded.company_name,
           completed_by=excluded.completed_by,
           completed_by_name=excluded.completed_by_name,
           status=excluded.status,
           updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(
        crypto.randomUUID(),
        missionId,
        occurrenceDate,
        actor.companyId,
        storeName,
        actor.id,
        actor.displayName,
        status,
      )
      .run();
    if (status === "completed" && existing?.status !== "completed") {
      await notifyMissionCreator(database, mission, storeName);
    }
    return jsonResponse({ status, completed: status === "completed" });
  } catch (error) {
    console.error("Não foi possível concluir a missão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A MISSÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "missions:delete")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR MISSÕES." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: "MISSÃO INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    await database.batch([
      database.prepare("DELETE FROM mission_completions WHERE mission_id=?1").bind(id),
      database.prepare("DELETE FROM missions WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a missão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A MISSÃO." }, 500);
  }
}
