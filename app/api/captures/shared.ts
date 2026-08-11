export type JsonMap = Record<string, unknown>;
export type CaptureStatus = "submitted" | "received" | "ready" | "assigned";
export type CaptureCategory = "console" | "controller" | "other";
export type Identity = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  accessGroup: string;
  companyId: string;
  permissions: string[];
};
export type CaptureRow = {
  id: string;
  category: CaptureCategory;
  productName: string;
  serialNumber: string;
  defects: string;
  color: string;
  originCompanyId: string;
  originCompanyName: string;
  capturedValueCents: number;
  photoKey: string;
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

export const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;
export const CAPTURE_STATUSES = new Set<CaptureStatus>([
  "submitted",
  "received",
  "ready",
  "assigned",
]);

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
    username: safeText(request.headers.get("x-unigames-username"), 80).toLowerCase(),
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

export function canAccessCaptures(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("captures");
}

// Helper central p/ identificar contas de assistência — reaproveitado por
// todas as rotas de captação (lista, cadastro, ações de fluxo e foto) para
// manter a mesma regra de negócio em um único lugar.
export function isAssistanceActor(actor: Identity) {
  const displayName = actor.displayName.toLowerCase();
  return (
    actor.accessGroup === "assistance" ||
    actor.accessGroup === "assistencia" ||
    actor.username.includes("assistencia") ||
    displayName.includes("assistencia")
  );
}

export function canSeeCapturedValue(actor: Identity, row: CaptureRow) {
  return actor.role === "admin" || actor.companyId === row.originCompanyId;
}

export function canSeePhoto(actor: Identity, row: CaptureRow) {
  return (
    actor.role === "admin" ||
    actor.companyId === row.originCompanyId ||
    isAssistanceActor(actor)
  );
}

export function serializeCaptureRow(actor: Identity, row: CaptureRow) {
  const { capturedValueCents, photoKey, ...rest } = row;
  const result: JsonMap = { ...rest };
  if (canSeeCapturedValue(actor, row)) result.capturedValue = capturedValueCents / 100;
  if (canSeePhoto(actor, row) && photoKey) result.hasPhoto = true;
  return result;
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

export async function companyName(database: D1Database, companyId: string) {
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

export const CAPTURE_SELECT = `
  SELECT id, category, product_name AS productName,
         serial_number AS serialNumber, defects, color,
         origin_company_id AS originCompanyId,
         origin_company_name AS originCompanyName,
         captured_value_cents AS capturedValueCents,
         photo_key AS photoKey, status,
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

const ALLOWED_PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
const MAX_PHOTO_SIZE = 8 * 1024 * 1024;

export function photoValidationError(file: File) {
  if (file.size <= 0) return "SELECIONE UMA FOTO VÁLIDA.";
  if (file.size > MAX_PHOTO_SIZE) return "A FOTO DEVE TER NO MÁXIMO 8 MB.";
  if (file.type && !ALLOWED_PHOTO_TYPES[file.type]) {
    return "FORMATO DE FOTO NÃO SUPORTADO.";
  }
  return "";
}

export function photoKeyFor(captureId: string, file: File) {
  const extension = ALLOWED_PHOTO_TYPES[file.type] || "jpg";
  return `captures/${captureId}/photo-${Date.now()}.${extension}`;
}

export async function uploadsBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  const bucket = (env as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) {
    throw new Error("O ARMAZENAMENTO DE ARQUIVOS NÃO ESTÁ DISPONÍVEL.");
  }
  return bucket;
}
