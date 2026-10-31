import { getD1 } from "../../../db";
import {
  benefitCycle,
  countedDaysInCycle,
  parseBenefitRules,
  type BenefitCycle,
  type BenefitRules,
} from "../../lib/hr-benefit-cycle";
import { isWorkSchedule } from "../../lib/working-days";
import { normalizeChecklist, terminationError } from "../../lib/hr-rh";
import { actingStoreFor } from "../../lib/acting-store";
import { computeOvertime } from "../../lib/hr-accounting-report";
import { todayInTimezone } from "../../lib/finance-status";

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

// Cadastro de Funcionários: permissões próprias (rh_funcionarios:view/create/
// edit/delete). Quem tem payroll:manage continua podendo tudo. Salário, PIX,
// banco e benefícios ficam só com o RH Financeiro (payroll:manage).
export type EmployeeAction = "view" | "create" | "edit" | "delete";
export function canEmployees(actor: Identity, action: EmployeeAction) {
  return canManagePayroll(actor) || actor.permissions.includes(`rh_funcionarios:${action}`);
}
export function canSeeEmployees(actor: Identity) {
  return canManagePayroll(actor) || actor.permissions.some((permission) => permission.startsWith("rh_funcionarios:"));
}
export const EMPLOYEE_FINANCIAL_FIELDS = ["salaryCents", "pixKey", "bankName", "foodPerDayCents", "transportPerDayCents", "benefitNotes",
  "benefitFoodTotalCents", "benefitTransportTotalCents", "benefitPaymentMethod", "facepontoCents"] as const;

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
  rg: string;
  telefone: string;
  admissionDate: string;
  companyId: string;
  companyName: string;
  // Loja de ADMISSÃO (onde está registrado) — a loja de cada mês vem de
  // actingStoreFor (app/lib/acting-store.ts).
  admissionCompanyId: string;
  admissionCompanyName: string;
  roleTitle: string;
  salaryCents: number;
  pixKey: string;
  bankName: string;
  status: string;
  workSchedule: string;
  foodPerDayCents: number;
  transportPerDayCents: number;
  benefitNotes: string;
  benefitFoodTotalCents: number;
  benefitTransportTotalCents: number;
  benefitPaymentMethod: string;
  facepontoCents: number;
  userId: string;
  notes: string;
  // Link da pasta do Drive com os documentos do funcionário ('' = sem link).
  driveLink: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

export const EMPLOYEE_COLUMNS = `id, full_name AS fullName, cpf, rg, telefone, admission_date AS admissionDate,
  company_id AS companyId, company_name AS companyName, role_title AS roleTitle,
  admission_company_id AS admissionCompanyId, admission_company_name AS admissionCompanyName,
  salary_cents AS salaryCents, pix_key AS pixKey, bank_name AS bankName, status,
  work_schedule AS workSchedule, food_per_day_cents AS foodPerDayCents,
  transport_per_day_cents AS transportPerDayCents, benefit_notes AS benefitNotes,
  benefit_food_total_cents AS benefitFoodTotalCents, benefit_transport_total_cents AS benefitTransportTotalCents,
  benefit_payment_method AS benefitPaymentMethod, faceponto_cents AS facepontoCents,
  user_id AS userId, notes, drive_link AS driveLink, birth_date AS birthDate, created_by AS createdBy, created_by_name AS createdByName,
  created_at AS createdAt, updated_by AS updatedBy, updated_by_name AS updatedByName,
  updated_at AS updatedAt`;

/**
 * Desligamento → bloqueia o login vinculado ao funcionário (RH ›
 * Funcionários › Conta de acesso): active=0 e session_version+1, o que
 * derruba na hora todas as sessões abertas (o Worker confere os dois a cada
 * requisição). Contas de administrador não são bloqueadas automaticamente,
 * para um lançamento errado no RH não trancar a administração do sistema.
 * Reativar o funcionário NÃO reativa o login — isso é feito em Cadastro de
 * Usuários, de propósito.
 */
export function deactivateLinkedLogin(database: Database, employeeId: string) {
  return database
    .prepare(
      `UPDATE app_users SET active=0, session_version=session_version+1, updated_at=CURRENT_TIMESTAMP
       WHERE active=1 AND role<>'admin'
         AND id=(SELECT user_id FROM hr_employees WHERE id=?1 AND user_id<>'')`,
    )
    .bind(employeeId);
}

/**
 * Desligamento (motivo + checklist demissional) lido do corpo da requisição:
 * { terminationDate, reason, reasonOther, checklist }. Devolve o erro de
 * validação ou os campos prontos para gravar em hr_terminations.
 */
export function terminationFields(value: unknown) {
  const raw = value && typeof value === "object" ? (value as JsonMap) : {};
  const date = safeText(raw.terminationDate, 10);
  const reason = safeText(raw.reason, 30);
  const reasonOther = safeText(raw.reasonOther, 300);
  const paid = safeText(raw.severancePaidDate, 10);
  const severancePaidDate = DATE_PATTERN.test(paid) ? paid : "";
  const error = terminationError(date, reason, reasonOther) ||
    (paid && !severancePaidDate ? "INFORME UMA DATA DE PAGAMENTO DA RESCISÃO VÁLIDA." : "");
  const checklist = normalizeChecklist(raw.checklist);
  // JSON não passa pela CAIXA ALTA do getD1: as observações convertem aqui.
  for (const entry of Object.values(checklist)) entry.note = entry.note.toLocaleUpperCase("pt-BR");
  return { error, date, reason, reasonOther: reason === "outro" ? reasonOther : "", checklistJson: JSON.stringify(checklist), severancePaidDate };
}

export function insertTermination(
  database: Database,
  values: {
    employeeId: string; employeeName: string; companyId: string; companyName: string;
    date: string; reason: string; reasonOther: string; checklistJson: string; severancePaidDate?: string;
    severanceCents?: number; fgtsCents?: number; notes?: string;
  },
  actor: Identity,
) {
  const id = crypto.randomUUID();
  return {
    id,
    statement: database
      .prepare(
        `INSERT INTO hr_terminations
          (id, employee_id, employee_name, company_id, company_name, termination_date,
           severance_cents, fgts_cents, notes, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at, reason, reason_other, checklist_json, severance_paid_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP, ?10, ?11, CURRENT_TIMESTAMP, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        id, values.employeeId, values.employeeName, values.companyId, values.companyName, values.date,
        values.severanceCents ?? 0, values.fgtsCents ?? 0, values.notes ?? "", actor.id, actorName(actor),
        values.reason, values.reasonOther, values.checklistJson, values.severancePaidDate ?? "",
      ),
  };
}

export async function loadEmployee(database: Database, employeeId: string) {
  return await database
    .prepare(`SELECT ${EMPLOYEE_COLUMNS} FROM hr_employees WHERE id=?1 LIMIT 1`)
    .bind(employeeId)
    .first<EmployeeRow>();
}

/**
 * Funcionário com a LOJA ATUANTE do mês no lugar da loja do cadastro — é a
 * loja que vai para a Folha, os Benefícios e o Comissionamento daquele mês
 * (e, por eles, para a DRE). Ver app/lib/acting-store.ts.
 */
export async function loadEmployeeForMonth(database: Database, employeeId: string, month: string) {
  const employee = await loadEmployee(database, employeeId);
  if (!employee) return null;
  const store = await actingStoreFor(database, employeeId, month);
  return store ? { ...employee, companyId: store.companyId, companyName: store.companyName } : employee;
}

export type CommissionTotalsRow = {
  commissionCents: number;
  /** Premiação do Comercial (migration 0110) — separada da comissão. */
  commercialPremiumCents?: number;
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
    Number(row.commercialPremiumCents || 0) +
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
      `SELECT commission_cents AS commissionCents, commercial_premium_cents AS commercialPremiumCents,
              bonuses_cents AS bonusesCents, premiums_cents AS premiumsCents, discounts_cents AS discountsCents,
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
 * Comissão BRUTA do funcionário no mês — sem subtrair os descontos
 * (comissão + bônus + prêmios + ajustes). Usada pelo "Custo Total".
 */
export async function computedCommissionGrossCentsFor(
  database: Database,
  employeeId: string,
  month: string,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT commission_cents + commercial_premium_cents AS commissionCents, bonuses_cents AS bonusesCents,
              premiums_cents AS premiumsCents, adjustments_cents AS adjustmentsCents
       FROM hr_commissions WHERE employee_id=?1 AND month=?2 LIMIT 1`,
    )
    .bind(employeeId, month)
    .first<{
      commissionCents: number;
      bonusesCents: number;
      premiumsCents: number;
      adjustmentsCents: number;
    }>();
  if (!row) return 0;
  return (
    Number(row.commissionCents || 0) +
    Number(row.bonusesCents || 0) +
    Number(row.premiumsCents || 0) +
    Number(row.adjustmentsCents || 0)
  );
}

/**
 * Benefícios BRUTOS do mês (Σ gross_cents) e a parte líquida paga via Pix
 * (Σ amount_cents onde payment_method='pix') — a primeira alimenta o Custo
 * Total, a segunda a Folha Paga.
 */
export async function computedBenefitsSplitFor(
  database: Database,
  employeeId: string,
  month: string,
): Promise<{ grossCents: number; pixNetCents: number }> {
  const row = await database
    .prepare(
      `SELECT COALESCE(SUM(gross_cents), 0) AS grossCents,
              COALESCE(SUM(CASE WHEN payment_method = 'pix' THEN amount_cents ELSE 0 END), 0) AS pixNetCents
       FROM hr_benefits WHERE employee_id=?1 AND month=?2`,
    )
    .bind(employeeId, month)
    .first<{ grossCents: number; pixNetCents: number }>();
  return {
    grossCents: Number(row?.grossCents ?? 0),
    pixNetCents: Number(row?.pixNetCents ?? 0),
  };
}

/**
 * Encargos patronais (pontos-base sobre o salário base) da configuração
 * global da Folha. Tabela pode estar vazia — devolve 0.
 */
export async function loadEmployerChargesBps(database: Database): Promise<number> {
  const row = await database
    .prepare(
      "SELECT employer_charges_bps AS bps FROM hr_payroll_settings WHERE company_id='' LIMIT 1",
    )
    .first<{ bps: number }>();
  return Math.max(0, Number(row?.bps ?? 0));
}

/**
 * Texto livre que descreve como a comissão é apurada (item 1). Só para
 * exibição no lançamento e no recibo — nunca entra em cálculo. Tabela pode
 * estar vazia: devolve "".
 */
export async function loadCommissionRuleText(database: Database): Promise<string> {
  const row = await database
    .prepare(
      "SELECT commission_rule_text AS text FROM hr_payroll_settings WHERE company_id='' LIMIT 1",
    )
    .first<{ text: string }>();
  return typeof row?.text === "string" ? row.text : "";
}

/** Regras da aba REGRAS de Benefícios (padrões quando nunca foram salvas). */
export async function loadBenefitRules(database: Database): Promise<BenefitRules> {
  const row = await database
    .prepare("SELECT value_json AS value FROM hr_settings WHERE key='benefit_rules'")
    .first<{ value: string }>();
  return parseBenefitRules(row?.value ?? "{}");
}

/**
 * Dias exatos do funcionário no CICLO de benefícios da competência (20 do
 * mês → 19 do mês seguinte) pela escala cadastrada: 5x2 = seg–sex, 6x1 =
 * seg–sáb. Ajustes (faltas, feriados…) são feitos na revisão do ciclo.
 */
export function workingDaysForEmployee(
  employee: { workSchedule: string },
  month: string,
): { workingDays: number; cycle: BenefitCycle | null; schedule: "5x2" | "6x1" } {
  const schedule = isWorkSchedule(employee.workSchedule) ? employee.workSchedule : "5x2";
  const cycle = benefitCycle(month);
  return { workingDays: cycle ? countedDaysInCycle(cycle, schedule) : 0, cycle, schedule };
}

/**
 * Grava a LOJA ATUANTE do funcionário num mês (hr_schedule_assignments, a
 * mesma tabela das Escalas — fonte única). Um registro por funcionário e mês.
 */
export function upsertActingStoreStatement(
  database: Database,
  input: { employeeId: string; employeeName: string; month: string; companyId: string; companyName: string },
  actor: Identity,
) {
  return database
    .prepare(
      `INSERT INTO hr_schedule_assignments
        (id, employee_id, employee_name, company_id, company_name, reference_month, notes,
         created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)
       ON CONFLICT (employee_id, reference_month) DO UPDATE
         SET company_id = EXCLUDED.company_id, company_name = EXCLUDED.company_name,
             employee_name = EXCLUDED.employee_name, updated_by = EXCLUDED.updated_by,
             updated_by_name = EXCLUDED.updated_by_name, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      crypto.randomUUID(), input.employeeId, input.employeeName, input.companyId, input.companyName, input.month,
      actor.id, actorName(actor),
    );
}

/**
 * Grava (store) ou remove (null) a LOJA ATUANTE de um mês e sincroniza: os
 * lançamentos do RH do mês até o próximo mês com registro passam para a loja
 * do mês, e a loja ATUAL do cadastro acompanha o mês corrente. Usado pela
 * loja atuante do cadastro e pelo LOTE (RH > Funcionários > LOJA ATUANTE).
 */
export async function saveActingStoreMonth(
  database: Database,
  actor: Identity,
  input: { employeeId: string; employeeName: string; month: string; store: { companyId: string; companyName: string } | null },
) {
  const { employeeId, month } = input;
  await database.batch([
    input.store
      ? upsertActingStoreStatement(database, { employeeId, employeeName: input.employeeName, month, ...input.store }, actor)
      : database.prepare("DELETE FROM hr_schedule_assignments WHERE employee_id=?1 AND reference_month=?2").bind(employeeId, month),
  ]);
  const store = await actingStoreFor(database, employeeId, month);
  const next = await database
    .prepare("SELECT MIN(reference_month) AS month FROM hr_schedule_assignments WHERE employee_id=?1 AND reference_month > ?2 AND company_id <> ''")
    .bind(employeeId, month)
    .first<{ month: string | null }>();
  const sync: ReturnType<typeof database.prepare>[] = [];
  if (store) {
    for (const table of ["hr_payroll_entries", "hr_benefits", "hr_commissions"]) {
      sync.push(
        database
          .prepare(
            `UPDATE ${table} SET company_id=?1, company_name=?2
             WHERE employee_id=?3 AND month >= ?4 AND (?5 = '' OR month < ?5)`,
          )
          .bind(store.companyId, store.companyName, employeeId, month, next?.month ?? ""),
      );
    }
  }
  const current = await actingStoreFor(database, employeeId, todayInTimezone().slice(0, 7));
  if (current?.companyId) {
    sync.push(
      database
        .prepare("UPDATE hr_employees SET company_id=?1, company_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3")
        .bind(current.companyId, current.companyName, employeeId),
    );
  }
  if (sync.length) await database.batch(sync);
  return current;
}

// Valores MANUAIS por funcionário e competência (migration 0109):
// 'dsr' (Folha / CUSTO TOTAL POR FUNCIONÁRIO), 'inss' (DRE Funcionário) e
// 'he' (HORAS EXTRAS em R$ do Relatório Contabilidade — 23/10/2026).
export const MONTH_VALUE_KINDS = ["dsr", "inss", "he"] as const;
export type MonthValueKind = (typeof MONTH_VALUE_KINDS)[number];

export function isMonthValueKind(value: unknown): value is MonthValueKind {
  return typeof value === "string" && (MONTH_VALUE_KINDS as readonly string[]).includes(value);
}

/** employeeId → centavos do tipo no mês (sem linha = 0). */
export async function loadMonthValues(database: Database, month: string, kind: MonthValueKind): Promise<Map<string, number>> {
  const rows = await database
    .prepare("SELECT employee_id AS employeeId, amount_cents AS amountCents FROM hr_employee_month_values WHERE month=?1 AND kind=?2")
    .bind(month, kind)
    .all<{ employeeId: string; amountCents: number }>();
  return new Map((rows.results ?? []).map((row) => [row.employeeId, Number(row.amountCents || 0)]));
}

/** Grava (ou apaga, com 0) o valor manual de um funcionário no mês. */
export function upsertMonthValueStatement(
  database: Database,
  input: { employeeId: string; employeeName: string; month: string; kind: MonthValueKind; amountCents: number },
  actor: Identity,
) {
  if (input.amountCents <= 0) {
    return database
      .prepare("DELETE FROM hr_employee_month_values WHERE employee_id=?1 AND month=?2 AND kind=?3")
      .bind(input.employeeId, input.month, input.kind);
  }
  return database
    .prepare(
      `INSERT INTO hr_employee_month_values
        (id, employee_id, employee_name, month, kind, amount_cents, updated_by, updated_by_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
       ON CONFLICT (employee_id, month, kind) DO UPDATE
         SET amount_cents = EXCLUDED.amount_cents, employee_name = EXCLUDED.employee_name,
             updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      crypto.randomUUID(), input.employeeId, input.employeeName, input.month, input.kind, input.amountCents,
      actor.id, actorName(actor),
    );
}

/**
 * HORAS EXTRAS A PAGAR do mês em R$ (Controle de Horas > HORAS PAGAS, três
 * tipos — migration 0110): employeeId → total. Quando há valor aqui, ele é a
 * HE do mês na Folha, na DRE e nos relatórios (fonte única); sem valor, vale o
 * campo HE digitado na Folha.
 */
export async function loadOvertimePayouts(database: Database, month: string): Promise<Map<string, number>> {
  const rows = await database
    .prepare(
      `SELECT employee_id AS employeeId, he50_minutes AS he50Minutes, he100_minutes AS he100Minutes, night_minutes AS nightMinutes,
              he50_rate_cents AS he50RateCents, he100_rate_cents AS he100RateCents, night_rate_cents AS nightRateCents
       FROM hr_time_tracking_payouts WHERE year_month=?1`,
    )
    .bind(month)
    .all<OvertimePayoutRow>();
  const result = new Map<string, number>();
  for (const row of rows.results ?? []) {
    const amount = computeOvertime(overtimeInputOf(row)).totalCents;
    if (amount > 0) result.set(row.employeeId, amount);
  }
  return result;
}

export type OvertimePayoutRow = {
  employeeId: string;
  he50Minutes: number;
  he100Minutes: number;
  nightMinutes: number;
  he50RateCents: number;
  he100RateCents: number;
  nightRateCents: number;
};

export function overtimeInputOf(row: OvertimePayoutRow) {
  return {
    he50: { minutes: Number(row.he50Minutes || 0), rateCents: Number(row.he50RateCents || 0) },
    he100: { minutes: Number(row.he100Minutes || 0), rateCents: Number(row.he100RateCents || 0) },
    night: { minutes: Number(row.nightMinutes || 0), rateCents: Number(row.nightRateCents || 0) },
  };
}
