import { getD1 } from "../../../db";
import { BIRTH_DATE_PATTERN, resolveBirthdayStatus, saoPauloToday, type BirthdayStatus } from "../../lib/hr-birthdays";

// RH > Aniversariantes — lista de colaboradores com data de nascimento
// cadastrada, status Feito/Passou/Faltando calculado a partir da data
// atual. Reaproveita o cadastro hr_employees (colunas birth_date e
// birthday_acknowledged_year) em vez de duplicar nome/loja numa tabela
// própria (decisão confirmada com o usuário). Permissão própria
// rh_aniversariantes:view/:manage (ver MODULE_VIEW_PERMISSIONS.birthdays em
// worker/index.ts), independente das demais permissões de RH.

export { BIRTH_DATE_PATTERN, resolveBirthdayStatus, saoPauloToday, type BirthdayStatus };

export type JsonMap = Record<string, unknown>;

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export type Database = Awaited<ReturnType<typeof getD1>>;

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

export function canViewBirthdays(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("rh_aniversariantes:view") ||
    actor.permissions.includes("rh_aniversariantes:manage")
  );
}

export function canManageBirthdays(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("rh_aniversariantes:manage");
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

export type EmployeeBirthdayRow = {
  id: string;
  fullName: string;
  companyId: string;
  companyName: string;
  birthDate: string;
  birthdayAcknowledgedYear: number;
};

export const EMPLOYEE_BIRTHDAY_COLUMNS = `
  id, full_name AS fullName, company_id AS companyId, company_name AS companyName,
  birth_date AS birthDate, birthday_acknowledged_year AS birthdayAcknowledgedYear
`;
