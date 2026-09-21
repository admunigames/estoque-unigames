import { getD1 } from "../../../db";
import {
  MOVEMENT_TYPES,
  PIECE_TYPE_LABELS,
  PIECE_TYPES,
  SIZES,
  TERM_STATUSES,
  isMovementType,
  isPieceType,
  isSize,
  isTermStatus,
  resolveMovementDelta,
  stockItemId,
  type MovementType,
  type PieceType,
  type Size,
  type TermStatus,
} from "../../lib/hr-uniform-stock";

// RH > Fardamento — controle de estoque de uniformes e casacos por tipo de
// peça + tamanho. Estoque ÚNICO para a empresa toda (não segmentado por
// loja — decisão confirmada com o usuário). Permissão própria
// rh_fardamento:view/:manage (ver MODULE_VIEW_PERMISSIONS.uniformStock em
// worker/index.ts), independente das demais permissões de RH. Catálogo
// (tipos de peça, tamanhos, tipos de lançamento) e o cálculo do delta de
// estoque vivem em app/lib/hr-uniform-stock.ts (lógica pura, sem
// dependência de banco), reexportados aqui pros handlers de rota.

export {
  MOVEMENT_TYPES,
  PIECE_TYPE_LABELS,
  PIECE_TYPES,
  SIZES,
  TERM_STATUSES,
  isMovementType,
  isPieceType,
  isSize,
  isTermStatus,
  resolveMovementDelta,
  stockItemId,
  type MovementType,
  type PieceType,
  type Size,
  type TermStatus,
};

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

export function canViewUniformStock(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("rh_fardamento:view") ||
    actor.permissions.includes("rh_fardamento:manage")
  );
}

export function canManageUniformStock(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("rh_fardamento:manage");
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

export function uuidIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export const MOVEMENT_COLUMNS = `
  id, movement_type AS movementType, piece_type AS pieceType, size, quantity,
  employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName,
  movement_date AS movementDate, note,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
`;

export type MovementRow = {
  id: string;
  movementType: MovementType;
  pieceType: PieceType;
  size: Size;
  quantity: number;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  movementDate: string;
  note: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

export const TERM_COLUMNS = `
  id, movement_id AS movementId, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, size, status,
  file_name AS fileName, r2_key AS r2Key, size_bytes AS sizeBytes,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
`;

export type TermRow = {
  id: string;
  movementId: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  size: Size;
  status: TermStatus;
  fileName: string;
  r2Key: string;
  sizeBytes: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};
