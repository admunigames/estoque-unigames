import { getD1 } from "../../../db";

// RH > Recrutamento e Seleção — pipeline único de candidato (Selecionado
// Entrevista > Em Teste > Em Treinamento > Contratado > Integração >
// Cancelado). Permissão própria rh_recrutamento:view/:manage (ver
// MODULE_VIEW_PERMISSIONS.recruitment em worker/index.ts), independente das
// demais permissões de RH.

export type JsonMap = Record<string, unknown>;

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export type Database = Awaited<ReturnType<typeof getD1>>;

export const STATUSES = [
  "selecionado_entrevista",
  "em_teste",
  "em_treinamento",
  "contratado",
  "integracao",
  "cancelado",
] as const;
export type RecruitmentStatus = (typeof STATUSES)[number];

export function isStatusValid(value: string): value is RecruitmentStatus {
  return (STATUSES as readonly string[]).includes(value);
}

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

export function canViewRecruitment(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("rh_recrutamento:view") ||
    actor.permissions.includes("rh_recrutamento:manage")
  );
}

export function canManageRecruitment(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("rh_recrutamento:manage");
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

export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function boolToInt(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1" ? 1 : 0;
}

export function uuidIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export function centsValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

export const CANDIDATE_COLUMNS = `
  id, full_name AS fullName, desired_role AS desiredRole, status,
  interview_date AS interviewDate, interview_time AS interviewTime, script_sent AS scriptSent,
  interview_result AS interviewResult, interview_result_reason AS interviewResultReason,
  test_script_sent AS testScriptSent, test_confirmed AS testConfirmed,
  cancelled_at AS cancelledAt, cancelled_reason AS cancelledReason,
  kit_delivered AS kitDelivered, kit_delivered_date AS kitDeliveredDate,
  training_start_date AS trainingStartDate, admission_date AS admissionDate,
  admission_company_id AS admissionCompanyId, admission_company_name AS admissionCompanyName,
  fixed_unit_id AS fixedUnitId, fixed_unit_name AS fixedUnitName,
  uniform_sent AS uniformSent, uniform_sent_date AS uniformSentDate,
  system1_done AS system1Done, system1_date AS system1Date,
  system2_done AS system2Done, system2_date AS system2Date,
  system3_done AS system3Done, system3_date AS system3Date,
  ifood_done AS ifoodDone, ifood_date AS ifoodDate,
  benefits_included AS benefitsIncluded, benefits_calculated AS benefitsCalculated, benefits_date AS benefitsDate,
  faceponto_done AS facepontoDone, faceponto_date AS facepontoDate,
  payjoy_done AS payjoyDone, payjoy_date AS payjoyDate,
  birthday_list_added AS birthdayListAdded, birthday_list_date AS birthdayListDate,
  photo_taken AS photoTaken,
  aso_requested AS asoRequested, aso_clinic AS asoClinic, aso_value_cents AS asoValueCents,
  shopping_registered AS shoppingRegistered, admission_docs_drive_link AS admissionDocsDriveLink,
  dental_plan_included AS dentalPlanIncluded, dental_plan_date AS dentalPlanDate,
  references_checked AS referencesChecked,
  integration_meeting_done AS integrationMeetingDone, integration_term_signed AS integrationTermSigned,
  integration_term_file_name AS integrationTermFileName, integration_term_r2_key AS integrationTermR2Key,
  integration_term_size_bytes AS integrationTermSizeBytes,
  integration_print_file_name AS integrationPrintFileName, integration_print_r2_key AS integrationPrintR2Key,
  integration_print_size_bytes AS integrationPrintSizeBytes,
  integration_meeting_transcript AS integrationMeetingTranscript,
  hr_employee_id AS hrEmployeeId,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
`;

export type CandidateRow = {
  id: string;
  fullName: string;
  desiredRole: string;
  status: string;
  interviewDate: string;
  interviewTime: string;
  scriptSent: number;
  interviewResult: string;
  interviewResultReason: string;
  testScriptSent: number;
  testConfirmed: number;
  cancelledAt: string;
  cancelledReason: string;
  kitDelivered: number;
  kitDeliveredDate: string;
  trainingStartDate: string;
  admissionDate: string;
  admissionCompanyId: string;
  admissionCompanyName: string;
  fixedUnitId: string;
  fixedUnitName: string;
  uniformSent: number;
  uniformSentDate: string;
  system1Done: number;
  system1Date: string;
  system2Done: number;
  system2Date: string;
  system3Done: number;
  system3Date: string;
  ifoodDone: number;
  ifoodDate: string;
  benefitsIncluded: number;
  benefitsCalculated: number;
  benefitsDate: string;
  facepontoDone: number;
  facepontoDate: string;
  payjoyDone: number;
  payjoyDate: string;
  birthdayListAdded: number;
  birthdayListDate: string;
  photoTaken: number;
  asoRequested: number;
  asoClinic: string;
  asoValueCents: number;
  shoppingRegistered: number;
  admissionDocsDriveLink: string;
  dentalPlanIncluded: number;
  dentalPlanDate: string;
  referencesChecked: number;
  integrationMeetingDone: number;
  integrationTermSigned: number;
  integrationTermFileName: string;
  integrationTermR2Key: string;
  integrationTermSizeBytes: number;
  integrationPrintFileName: string;
  integrationPrintR2Key: string;
  integrationPrintSizeBytes: number;
  integrationMeetingTranscript: string;
  hrEmployeeId: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};
