import { getD1 } from "../../../db";

// RH > Escalas e Folgas — substitui uma planilha externa mantida
// manualmente. Jornada 6x1 (trabalha 6 dias, folga 1 por semana).
// Permissão própria rh_escalas:view/:manage (ver MODULE_VIEW_PERMISSIONS.
// schedules em worker/index.ts), independente das demais permissões de RH.
//
// O cálculo de folgas NÃO é persistido — é feito ao vivo em report/route.ts
// a partir de dois lançamentos manuais por mês: escala de domingos
// trabalhados (hr_schedule_sunday_work) e folga de segunda a sábado
// lançada dia a dia (hr_schedule_weekday_off, pois não é um dia fixo por
// colaborador). "Loja fixa do colaborador no mês" (hr_schedule_assignments)
// é conceito novo: hr_employees só guarda a loja ATUAL, sem histórico
// mensal.

export type JsonMap = Record<string, unknown>;

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function safeText(value: unknown, maxLength: number) {
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

export function identity(request: Request): Identity {
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

export function canViewSchedules(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("rh_escalas:view") ||
    actor.permissions.includes("rh_escalas:manage")
  );
}

export function canManageSchedules(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("rh_escalas:manage");
}

export function actorName(actor: Identity) {
  return actor.displayName || "Usuário";
}

export function sameOrigin(request: Request) {
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

export function uuidIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export const MONTH_PATTERN = /^\d{4}-\d{2}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidMonth(value: string) {
  return MONTH_PATTERN.test(value);
}

export function isValidDate(value: string) {
  return DATE_PATTERN.test(value);
}

/** getUTCDay() === 0 — datas são sempre 'YYYY-MM-DD' tratadas como UTC. */
export function isSunday(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0;
}

export function isWeekday(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() !== 0;
}

/** Confere se a data (YYYY-MM-DD) pertence ao mês de referência (YYYY-MM). */
export function dateInMonth(dateStr: string, referenceMonth: string) {
  return dateStr.slice(0, 7) === referenceMonth;
}

export type EmployeeRow = { id: string; fullName: string; companyName: string; status: string };

/** Colaboradores ativos, pra popular o select — mesma query de hr-time-tracking/shared.ts. */
export async function loadActiveEmployees(): Promise<EmployeeRow[]> {
  const database = await getD1();
  const result = await database
    .prepare(
      `SELECT id, full_name AS fullName, company_name AS companyName, status
       FROM hr_employees WHERE status='active' ORDER BY full_name ASC`,
    )
    .all<EmployeeRow>();
  return result.results ?? [];
}

export async function findAssignment(employeeId: string, referenceMonth: string) {
  const database = await getD1();
  return database
    .prepare(
      `SELECT id, employee_id AS employeeId, reference_month AS referenceMonth
       FROM hr_schedule_assignments WHERE employee_id=?1 AND reference_month=?2 LIMIT 1`,
    )
    .bind(employeeId, referenceMonth)
    .first<{ id: string; employeeId: string; referenceMonth: string }>();
}
