import { canSeeAllStores } from "../../lib/access-scope";

export type JsonMap = Record<string, unknown>;
export type CaptureStatus = "submitted" | "received" | "ready" | "assigned";
export type CaptureCategory = "console" | "controller" | "other" | "jogo";
export type GameConsole =
  | "PS4"
  | "PS3"
  | "PS5"
  | "Nintendo Switch"
  | "Xbox One/Series";
export type GameCondition = "Novo" | "Semi Novo";
export type Identity = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  accessGroup: string;
  companyId: string;
  sector: string;
  permissions: string[];
};
export type CaptureRow = {
  id: string;
  category: CaptureCategory;
  productName: string;
  gameName: string;
  gameConsole: string;
  gameCondition: string;
  serialNumber: string;
  defects: string;
  color: string;
  originCompanyId: string;
  originCompanyName: string;
  capturedValueCents: number;
  photoKey: string;
  parentCaptureId: string;
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
export const GAME_CONSOLES = new Set<GameConsole>([
  "PS4",
  "PS3",
  "PS5",
  "Nintendo Switch",
  "Xbox One/Series",
]);
export const GAME_CONDITIONS = new Set<GameCondition>(["Novo", "Semi Novo"]);
// Controles captados junto com um console viram linhas-filhas nesta mesma
// tabela (parent_capture_id apontando pro console) em vez de um objeto
// embutido, pra reaproveitar sem duplicação toda a lógica de status/destino
// que já existe por linha (ver PATCH em route.ts).
export const MAX_CAPTURE_CONTROLLERS = 8;

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
    sector: safeText(request.headers.get("x-unigames-sector"), 40),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

export function can(actor: Identity, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

export function canAccessCaptures(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.some((permission) => permission.startsWith("captures:"))
  );
}

// Helper central p/ identificar contas de assistência — reaproveitado por
// todas as rotas de captação (lista, cadastro, ações de fluxo e foto) para
// manter a mesma regra de negócio em um único lugar.
export function isAssistanceActor(actor: Identity) {
  const displayName = actor.displayName.toLowerCase();
  return (
    actor.sector === "assistance" ||
    actor.accessGroup === "assistance" ||
    actor.accessGroup === "assistencia" ||
    actor.username.includes("assistencia") ||
    displayName.includes("assistencia")
  );
}

export function canSeeCapturedValue(actor: Identity, row: CaptureRow) {
  return (
    actor.role === "admin" ||
    actor.companyId === row.originCompanyId ||
    canSeeAllStores(actor, "captures:view")
  );
}

export function canSeePhoto(actor: Identity, row: CaptureRow) {
  return (
    actor.role === "admin" ||
    actor.companyId === row.originCompanyId ||
    isAssistanceActor(actor) ||
    canSeeAllStores(actor, "captures:view")
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
         game_name AS gameName, game_console AS gameConsole,
         game_condition AS gameCondition,
         serial_number AS serialNumber, defects, color,
         origin_company_id AS originCompanyId,
         origin_company_name AS originCompanyName,
         captured_value_cents AS capturedValueCents,
         photo_key AS photoKey,
         parent_capture_id AS parentCaptureId, status,
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

export const ALLOWED_PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
export const MAX_PHOTO_SIZE = 8 * 1024 * 1024;
// Mesmo tamanho de pedaço usado no upload de anexos de Compras
// (app/api/compras/files/route.ts) — o corpo de uma requisição maior que
// ~1-2MB direto pro Worker volta 413 antes mesmo de chegar no handler, então
// fotos precisam ser enviadas em pedaços pequenos e remontadas no servidor.
export const PHOTO_CHUNK_SIZE = 512 * 1024;

export function photoMetaValidationError(
  fileName: string,
  contentType: string,
  fileSize: number,
) {
  if (!fileName || !Number.isInteger(fileSize) || fileSize <= 0) {
    return "SELECIONE UMA FOTO VÁLIDA.";
  }
  if (fileSize > MAX_PHOTO_SIZE) return "A FOTO DEVE TER NO MÁXIMO 8 MB.";
  if (!ALLOWED_PHOTO_TYPES[contentType]) return "FORMATO DE FOTO NÃO SUPORTADO.";
  return "";
}

export function photoExtension(contentType: string) {
  return ALLOWED_PHOTO_TYPES[contentType] || "jpg";
}

const PHOTO_KEY_PATTERN = /^captures\/[0-9a-f-]{36}\/photo\.(jpg|png|webp|heic|heif)$/i;

export function isValidPhotoKey(key: string) {
  return PHOTO_KEY_PATTERN.test(key);
}

export async function uploadsBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  const bucket = (env as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) {
    throw new Error("O ARMAZENAMENTO DE ARQUIVOS NÃO ESTÁ DISPONÍVEL.");
  }
  return bucket;
}
