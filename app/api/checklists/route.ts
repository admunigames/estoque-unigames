import webPush from "web-push";
import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canSeeAllStores } from "../../lib/access-scope";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type ChecklistKind = "checkin" | "checkout" | "shift_change";
type CompanyRecord = { id: string; name: string };
type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// Itens fixos de cada checklist — iguais para todas as lojas, não
// cadastráveis. Mudar a ordem/quantidade não afeta dados já salvos (a chave
// de cada item é o índice na lista, não o texto).
const CHECKLIST_ITEMS: Record<ChecklistKind, string[]> = {
  checkin: [
    "Ligar computadores",
    "Abrir sistemas necessários",
    "Abrir Click Massa",
    "Ligar maquinetas e certificar se estão carregadas",
    "Ligar TV's",
    "Espanar",
    "Varrer",
    "Descartar lixos necessários",
    "Lavar xícara e cafeteira",
    "Trocar água do mop",
    "Passar pano nos móveis",
    "Encher garrafas de água",
    "Reposição produtos",
    "Por saco nos lixos",
    "Relatório 41",
    "Verificar pendências grupos",
    "Revisar Kanban",
  ],
  checkout: [
    "Recolher lixo",
    "Colocar saco nos lixeiros",
    "Atualizar o Kanban",
    "Bater o caixa",
    "Varrer",
    "Desligar TV's",
    "Fechar caixa",
    "Fechar sistemas e notebook's",
    "Postagem do cumprimento da rotina",
  ],
  shift_change: ["Atualizar o Kanban", "Bater o caixa"],
};

// Ao completar 100% de uma checklist, o item equivalente na Rotina
// Operacional daquele dia (se o admin tiver cadastrado uma rotina com esse
// título) é marcado como concluído automaticamente — comparação normalizada
// (sem acento/maiúsculas/pontuação) pra não depender de grafia exata.
const ROUTINE_TITLE_MATCH: Record<ChecklistKind, string> = {
  checkin: "checkin",
  checkout: "checkout",
  shift_change: "trocadeturno",
};

const CHECKLIST_KINDS = new Set<ChecklistKind>(["checkin", "checkout", "shift_change"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;
const DIACRITICS_PATTERN = new RegExp(
  "[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]",
  "g",
);
const NON_ALNUM_PATTERN = /[^a-z0-9]/g;

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

function checklistKind(value: unknown): ChecklistKind | null {
  return typeof value === "string" && CHECKLIST_KINDS.has(value as ChecklistKind)
    ? (value as ChecklistKind)
    : null;
}

function normalizeTitle(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_PATTERN, "")
    .replace(NON_ALNUM_PATTERN, "");
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

// Depósito e Assistência são setores internos, não lojas — não recebem checklist.
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

// Se existir uma rotina operacional cujo título bate (normalizado) com o
// nome desta checklist, e a tarefa daquela rotina/loja/dia ainda não estiver
// concluída, marca como concluída — evita a loja marcar a mesma coisa duas
// vezes. Não reverte se a checklist for desmarcada depois.
async function completeLinkedRoutineTask(
  database: D1Database,
  kind: ChecklistKind,
  date: string,
  actor: Identity,
) {
  const target = ROUTINE_TITLE_MATCH[kind];
  const tasksResult = await database
    .prepare(
      `SELECT t.id, t.status, r.title, r.created_by AS createdBy
       FROM operational_routine_tasks t
       JOIN operational_routines r ON r.id = t.routine_id
       WHERE t.due_date=?1 AND t.company_id=?2`,
    )
    .bind(date, actor.companyId)
    .all<{ id: string; status: string; title: string; createdBy: string }>();

  const match = (tasksResult.results ?? []).find(
    (task) => task.status !== "completed" && normalizeTitle(task.title) === target,
  );
  if (!match) return false;

  await database
    .prepare(
      `UPDATE operational_routine_tasks SET
         status='completed', completed_by=?1, completed_by_name=?2,
         completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=?3`,
    )
    .bind(actor.id, actor.displayName, match.id)
    .run();

  const storeName = (await companyName(database, actor.companyId)) || "Loja";
  await notifyRoutineCreator(database, { title: match.title, createdBy: match.createdBy }, storeName);
  return true;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const url = new URL(request.url);
  const date = (url.searchParams.get("date") || "").trim();
  const kind = checklistKind(url.searchParams.get("kind"));
  if (!DATE_PATTERN.test(date)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
  if (!kind) return jsonResponse({ error: "CHECKLIST INVÁLIDA." }, 400);

  const items = CHECKLIST_ITEMS[kind];

  try {
    const database = await getD1();

    if (actor.companyId) {
      const rows = await database
        .prepare(
          `SELECT item_key AS itemKey, completed_by_name AS completedByName, completed_at AS completedAt
           FROM daily_checklist_items
           WHERE kind=?1 AND date=?2 AND company_id=?3 AND completed=1`,
        )
        .bind(kind, date, actor.companyId)
        .all<{ itemKey: string; completedByName: string; completedAt: string }>();
      const doneByKey = new Map((rows.results ?? []).map((row) => [row.itemKey, row]));
      const resolvedCompanyName = (await companyName(database, actor.companyId)) || "";

      return jsonResponse({
        date,
        kind,
        companyId: actor.companyId,
        companyName: resolvedCompanyName,
        mine: actor.role !== "admin",
        items: items.map((label, index) => {
          const key = String(index);
          const done = doneByKey.get(key);
          return {
            key,
            label,
            completed: Boolean(done),
            completedByName: done?.completedByName || "",
            completedAt: done?.completedAt || "",
          };
        }),
      });
    }

    if (canSeeAllStores(actor, "missions:view")) {
      const companies = await storeCompanies(database);
      const rows = await database
        .prepare(
          `SELECT company_id AS companyId, COUNT(*) AS doneCount, MAX(updated_at) AS lastUpdatedAt
           FROM daily_checklist_items
           WHERE kind=?1 AND date=?2 AND completed=1
           GROUP BY company_id`,
        )
        .bind(kind, date)
        .all<{ companyId: string; doneCount: number; lastUpdatedAt: string }>();
      const doneByCompany = new Map((rows.results ?? []).map((row) => [row.companyId, row]));

      return jsonResponse({
        date,
        kind,
        mine: false,
        stores: companies.map((company) => {
          const info = doneByCompany.get(company.id);
          return {
            companyId: company.id,
            companyName: company.name,
            doneCount: info ? Number(info.doneCount) : 0,
            totalCount: items.length,
            lastUpdatedAt: info?.lastUpdatedAt || "",
          };
        }),
      });
    }

    return jsonResponse({ date, kind, mine: false, items: [], stores: [] });
  } catch (error) {
    console.error("Não foi possível carregar a checklist.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A CHECKLIST." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  if (actor.role === "admin") {
    return jsonResponse({ error: "O ADMINISTRADOR NÃO PODE ALTERAR A CHECKLIST." }, 403);
  }
  if (!actor.id || !COMPANY_PATTERN.test(actor.companyId)) {
    return jsonResponse({ error: "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const kind = checklistKind(body.kind);
    const date = safeText(body.date, 10);
    const itemKey = safeText(body.itemKey, 10);
    const completed = body.completed === true;
    if (!kind) return jsonResponse({ error: "CHECKLIST INVÁLIDA." }, 400);
    if (!DATE_PATTERN.test(date)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    const itemIndex = Number(itemKey);
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= CHECKLIST_ITEMS[kind].length) {
      return jsonResponse({ error: "ITEM INVÁLIDO." }, 400);
    }

    const database = await getD1();
    const resolvedCompanyName = (await companyName(database, actor.companyId)) || "";

    if (completed) {
      await database
        .prepare(
          `INSERT INTO daily_checklist_items
            (id, kind, item_key, company_id, company_name, date, completed,
             completed_by, completed_by_name, completed_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (kind, item_key, company_id, date) DO UPDATE SET
             completed=1, completed_by=?7, completed_by_name=?8,
             completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`,
        )
        .bind(
          crypto.randomUUID(),
          kind,
          itemKey,
          actor.companyId,
          resolvedCompanyName,
          date,
          actor.id,
          actor.displayName,
        )
        .run();
    } else {
      await database
        .prepare(
          `DELETE FROM daily_checklist_items WHERE kind=?1 AND item_key=?2 AND company_id=?3 AND date=?4`,
        )
        .bind(kind, itemKey, actor.companyId, date)
        .run();
    }

    let linkedRoutineCompleted = false;
    let checklistComplete = false;
    if (completed) {
      const doneCountRow = await database
        .prepare(
          `SELECT COUNT(*) AS doneCount FROM daily_checklist_items
           WHERE kind=?1 AND date=?2 AND company_id=?3 AND completed=1`,
        )
        .bind(kind, date, actor.companyId)
        .first<{ doneCount: number }>();
      checklistComplete = Number(doneCountRow?.doneCount || 0) >= CHECKLIST_ITEMS[kind].length;
      if (checklistComplete) {
        linkedRoutineCompleted = await completeLinkedRoutineTask(database, kind, date, actor);
      }
    }

    return jsonResponse({ completed, checklistComplete, linkedRoutineCompleted });
  } catch (error) {
    console.error("Não foi possível atualizar a checklist.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A CHECKLIST." }, 500);
  }
}
