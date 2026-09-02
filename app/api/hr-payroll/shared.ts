import { getD1 } from "../../../db";
import { isWorkSchedule, workingDaysInMonth } from "../../lib/working-days";

// RH Financeiro (Financeiro Fase 5) — base compartilhada da Folha de
// Pagamento, dos Benefícios e do Comissionamento.
//
// Todo o módulo é liberado por UMA permissão só ("payroll:manage"),
// independente de "finance:manage" (ver canManagePayroll abaixo e
// MODULE_VIEW_PERMISSIONS.payroll em worker/index.ts): quem responde pelo RH
// acessa Folha/Benefícios/Comissionamento sem ganhar o resto do Financeiro,
// e vice-versa.

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

export function canManagePayroll(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("payroll:manage");
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

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const EMPLOYEE_STATUSES = ["active", "inactive"] as const;
export const BENEFIT_TYPES = [
  "alimentacao",
  "mobilidade",
  "premiacao",
  "saldo_livre",
  "outros",
] as const;
export const BENEFIT_PAYMENT_METHODS = ["pix", "cartao", "plataforma", "outros"] as const;
export const COMMISSION_KINDS = ["bonus", "premiacao", "desconto", "ajuste"] as const;

export type CommissionKind = (typeof COMMISSION_KINDS)[number];

export function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

export function centsValue(value: unknown) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function onlyDigits(value: string) {
  return value.replace(/\D+/g, "");
}

/**
 * CPF: 11 dígitos com os dois dígitos verificadores conferidos. O campo é
 * opcional no cadastro (''), mas quando informado precisa ser um CPF real —
 * é a chave usada para não duplicar funcionário (índice único parcial
 * hr_employees_cpf_idx).
 */
export function isValidCpf(digits: string) {
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  for (const [length, position] of [
    [9, 10],
    [10, 11],
  ]) {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (position - index);
    }
    const remainder = (sum * 10) % 11;
    const expected = remainder === 10 ? 0 : remainder;
    if (expected !== Number(digits[length])) return false;
  }
  return true;
}

export type EmployeeRow = {
  id: string;
  fullName: string;
  cpf: string;
  admissionDate: string;
  companyId: string;
  companyName: string;
  roleTitle: string;
  salaryCents: number;
  pixKey: string;
  bankName: string;
  status: string;
  workSchedule: string;
  userId: string;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

export const EMPLOYEE_COLUMNS = `id, full_name AS fullName, cpf, admission_date AS admissionDate,
  company_id AS companyId, company_name AS companyName, role_title AS roleTitle,
  salary_cents AS salaryCents, pix_key AS pixKey, bank_name AS bankName, status,
  work_schedule AS workSchedule,
  user_id AS userId, notes, created_by AS createdBy, created_by_name AS createdByName,
  created_at AS createdAt, updated_by AS updatedBy, updated_by_name AS updatedByName,
  updated_at AS updatedAt`;

export async function loadEmployee(database: Database, employeeId: string) {
  return await database
    .prepare(`SELECT ${EMPLOYEE_COLUMNS} FROM hr_employees WHERE id=?1 LIMIT 1`)
    .bind(employeeId)
    .first<EmployeeRow>();
}

export type CommissionTotalsRow = {
  commissionCents: number;
  bonusesCents: number;
  premiumsCents: number;
  discountsCents: number;
  adjustmentsCents: number;
};

/**
 * Valor final do comissionamento. Descontos são guardados como magnitude
 * positiva e subtraídos aqui; ajustes já vêm com sinal.
 */
export function commissionNetCents(row: CommissionTotalsRow) {
  return (
    Number(row.commissionCents || 0) +
    Number(row.bonusesCents || 0) +
    Number(row.premiumsCents || 0) -
    Number(row.discountsCents || 0) +
    Number(row.adjustmentsCents || 0)
  );
}

/**
 * Comissão do funcionário no mês, sempre recalculada a partir de
 * hr_commissions — a Folha NUNCA guarda esse valor em coluna própria, pra
 * não divergir da fonte quando o comissionamento é editado depois.
 */
export async function computedCommissionCentsFor(
  database: Database,
  employeeId: string,
  month: string,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT commission_cents AS commissionCents, bonuses_cents AS bonusesCents,
              premiums_cents AS premiumsCents, discounts_cents AS discountsCents,
              adjustments_cents AS adjustmentsCents
       FROM hr_commissions WHERE employee_id=?1 AND month=?2 LIMIT 1`,
    )
    .bind(employeeId, month)
    .first<CommissionTotalsRow>();
  return row ? commissionNetCents(row) : 0;
}

/**
 * Total de benefícios do funcionário na competência — soma de todos os
 * lançamentos de hr_benefits (vários por mês são permitidos). Também
 * recalculado ao vivo, nunca gravado na Folha.
 */
export async function computedBenefitsCentsFor(
  database: Database,
  employeeId: string,
  month: string,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM hr_benefits WHERE employee_id=?1 AND month=?2`,
    )
    .bind(employeeId, month)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/**
 * Datas de feriado (AAAA-MM-DD) que valem para a loja informada numa
 * competência: todos os 'nacional' + os 'local' daquela loja.
 */
export async function holidayDatesFor(
  database: Database,
  companyId: string,
  month: string,
): Promise<string[]> {
  const result = await database
    .prepare(
      `SELECT date FROM hr_holidays
       WHERE substr(date, 1, 7) = ?1
         AND (scope = 'nacional' OR (scope = 'local' AND company_id = ?2))`,
    )
    .bind(month, companyId || "")
    .all<{ date: string }>();
  return (result.results ?? []).map((row) => row.date);
}

/**
 * Dias úteis do funcionário na competência, pela escala cadastrada e pelos
 * feriados da loja — usado para benefícios pagos por dia trabalhado.
 */
export async function workingDaysForEmployee(
  database: Database,
  employee: { companyId: string; workSchedule: string },
  month: string,
): Promise<number> {
  const schedule = isWorkSchedule(employee.workSchedule) ? employee.workSchedule : "5x2";
  const holidays = await holidayDatesFor(database, employee.companyId, month);
  return workingDaysInMonth(month, schedule, holidays);
}
