import { canSeeAllStores, hasCompany } from "../../lib/access-scope";
import { RESOLVED_ITEM_STATUSES } from "../../lib/divergences";

// Base comum das rotas de Estoque > Divergências — mesmo estilo de
// app/api/outputs/route.ts: identidade só pelos headers x-unigames-*
// (setados pelo Worker), sameOrigin em toda escrita e escopo por loja via
// canSeeAllStores() + setor administrativo.

export type JsonMap = Record<string, unknown>;

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  sector: string;
  permissions: string[];
};

export type DivergencePermission =
  | "divergencias:view"
  | "divergencias:create"
  | "divergencias:edit"
  | "divergencias:delete"
  | "divergencias:respond"
  | "divergencias:inventory";

export type RequestRow = {
  id: string;
  companyId: string;
  companyName: string;
  status: string;
  notes: string;
  finalizedAt: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

export type ItemRow = {
  id: string;
  requestId: string;
  productCode: string;
  productName: string;
  physicalQty: number;
  systemQty: number;
  storeNotes: string;
  status: string;
  stockResponse: string;
  respondedBy: string;
  respondedByName: string;
  respondedAt: string;
  storeReply: string;
  storeReplyBy: string;
  storeReplyByName: string;
  storeReplyAt: string;
  inventoriedAt: string;
  inventoriedBy: string;
  inventoriedByName: string;
  createdByName: string;
  createdAt: string;
  updatedByName: string;
  updatedAt: string;
};

export const REQUEST_SELECT = `
  SELECT id, company_id AS companyId, company_name AS companyName, status, notes,
         finalized_at AS finalizedAt, created_by AS createdBy, created_by_name AS createdByName,
         created_at AS createdAt, updated_by AS updatedBy, updated_by_name AS updatedByName,
         updated_at AS updatedAt
  FROM divergence_requests`;

export const ITEM_COLUMNS = `
  i.id, i.request_id AS requestId, i.product_code AS productCode, i.product_name AS productName,
  i.physical_qty AS physicalQty, i.system_qty AS systemQty, i.store_notes AS storeNotes, i.status,
  i.stock_response AS stockResponse, i.responded_by AS respondedBy,
  i.responded_by_name AS respondedByName, i.responded_at AS respondedAt,
  i.store_reply AS storeReply, i.store_reply_by AS storeReplyBy,
  i.store_reply_by_name AS storeReplyByName, i.store_reply_at AS storeReplyAt,
  i.inventoried_at AS inventoriedAt, i.inventoried_by AS inventoriedBy,
  i.inventoried_by_name AS inventoriedByName, i.created_by_name AS createdByName,
  i.created_at AS createdAt, i.updated_by_name AS updatedByName, i.updated_at AS updatedAt`;

export const MAX_ITEMS = 100;
export const MAX_QTY = 999_999;

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
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    sector: safeText(request.headers.get("x-unigames-sector"), 40),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

export function can(actor: Identity, permission: DivergencePermission) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

export function canAny(actor: Identity, permissions: DivergencePermission[]) {
  return permissions.some((permission) => can(actor, permission));
}

// Mesma regra histórica de Saídas: setor Administrativo vê todas as lojas,
// além da regra genérica de canSeeAllStores() (sem loja + permissão).
export function isAdministrativeActor(actor: Identity) {
  return actor.sector === "administrative";
}

/** Vê/age em todas as lojas para a ação dada (admin, sem loja + permissão, ou administrativo). */
export function allStoresFor(actor: Identity, permission: DivergencePermission) {
  return canSeeAllStores(actor, permission) || isAdministrativeActor(actor);
}

/** Escopo de leitura: todas as lojas se QUALQUER permissão dada amplia o alcance. */
export function allStoresForAny(actor: Identity, permissions: DivergencePermission[]) {
  return permissions.some((permission) => allStoresFor(actor, permission));
}

/** Ator pode agir neste pedido (loja dele, ou todas as lojas para a ação). */
export function inScope(actor: Identity, permission: DivergencePermission, companyId: string) {
  if (allStoresFor(actor, permission)) return true;
  return hasCompany(actor.companyId) && actor.companyId === companyId;
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

export function quantity(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_QTY
    ? parsed
    : null;
}

export async function loadRequest(database: D1Database, id: string) {
  return database.prepare(`${REQUEST_SELECT} WHERE id=?1 LIMIT 1`).bind(id).first<RequestRow>();
}

export async function loadItems(database: D1Database, requestId: string) {
  const result = await database
    .prepare(`SELECT ${ITEM_COLUMNS} FROM divergence_items i WHERE i.request_id=?1 ORDER BY i.position, i.created_at, i.id`)
    .bind(requestId)
    .all<ItemRow>();
  return (result.results ?? []).map(normalizeItem);
}

export async function loadItem(database: D1Database, requestId: string, itemId: string) {
  const row = await database
    .prepare(`SELECT ${ITEM_COLUMNS} FROM divergence_items i WHERE i.id=?1 AND i.request_id=?2 LIMIT 1`)
    .bind(itemId, requestId)
    .first<ItemRow>();
  return row ? normalizeItem(row) : null;
}

// Postgres devolve integer como number, mas COUNT/SUM como string —
// normaliza tudo que é quantidade antes de responder.
export function normalizeItem(row: ItemRow): ItemRow {
  return { ...row, physicalQty: Number(row.physicalQty) || 0, systemQty: Number(row.systemQty) || 0 };
}

export function eventStatement(
  database: D1Database,
  event: {
    itemId: string;
    requestId: string;
    kind: "created" | "respond" | "store_reply" | "store_edit" | "inventoried";
    fromStatus: string;
    toStatus: string;
    text: string;
    actor: Identity;
    at: string;
  },
) {
  return database
    .prepare(
      `INSERT INTO divergence_item_events
        (id, item_id, request_id, kind, from_status, to_status, text, actor_id, actor_name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      crypto.randomUUID(),
      event.itemId,
      event.requestId,
      event.kind,
      event.fromStatus,
      event.toStatus,
      event.text.slice(0, 2000),
      event.actor.id,
      event.actor.displayName,
      event.at,
    );
}

const RESOLVED_SQL = RESOLVED_ITEM_STATUSES.map((status) => `'${status}'`).join(",");
// Mesma regra de computeRequestStatus() em app/lib/divergences.ts, em SQL,
// para rodar DENTRO do batch (transação) logo depois das mudanças de item.
const STATUS_CASE = `CASE
  WHEN NOT EXISTS (SELECT 1 FROM divergence_items WHERE request_id=?1 AND status<>'nao_visto') THEN 'aberto'
  WHEN NOT EXISTS (SELECT 1 FROM divergence_items WHERE request_id=?1 AND status NOT IN (${RESOLVED_SQL})) THEN 'finalizado'
  ELSE 'verificacao' END`;

/** Recalcula (e grava) o status do pedido a partir dos itens; vai no fim do batch. */
export function recalcStatement(database: D1Database, requestId: string, actor: Identity, at: string) {
  return database
    .prepare(
      `UPDATE divergence_requests
       SET status=${STATUS_CASE},
           finalized_at=CASE WHEN ${STATUS_CASE}='finalizado'
             THEN CASE WHEN finalized_at='' THEN ?2 ELSE finalized_at END ELSE '' END,
           updated_by=?3, updated_by_name=?4, updated_at=?2
       WHERE id=?1`,
    )
    .bind(requestId, at, actor.id, actor.displayName);
}

export function routeParam(value: unknown) {
  return safeText(value, 80);
}

// Quem lê a lista de pedidos: VISUALIZAR, e também quem precisa agir sobre
// pedidos existentes (responder, editar, excluir).
export const READ_PERMISSIONS: DivergencePermission[] = [
  "divergencias:view",
  "divergencias:respond",
  "divergencias:edit",
  "divergencias:delete",
];


export type ParsedItem = {
  id: string;
  productCode: string;
  productName: string;
  physicalQty: number;
  systemQty: number;
  storeNotes: string;
};

/** Valida a lista de itens enviada pela loja (criação e edição). */
export function parseItems(raw: unknown): { items: ParsedItem[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "INCLUA PELO MENOS UM PRODUTO." };
  if (raw.length > MAX_ITEMS) return { error: `MÁXIMO DE ${MAX_ITEMS} PRODUTOS POR PEDIDO.` };
  const items: ParsedItem[] = [];
  for (const [index, value] of raw.entries()) {
    const entry = (value && typeof value === "object" ? value : {}) as JsonMap;
    const label = `PRODUTO ${index + 1}`;
    const productName = safeText(entry.productName, 180);
    if (productName.length < 2) return { error: `${label}: INFORME O PRODUTO.` };
    const physicalQty = quantity(entry.physicalQty);
    if (physicalQty === null) return { error: `${label}: INFORME A QUANTIDADE FÍSICA (NÚMERO INTEIRO, 0 OU MAIS).` };
    const systemQty = quantity(entry.systemQty);
    if (systemQty === null) return { error: `${label}: INFORME A QUANTIDADE EM SISTEMA (NÚMERO INTEIRO, 0 OU MAIS).` };
    items.push({
      id: safeText(entry.id, 80),
      productCode: safeText(entry.productCode, 40),
      productName,
      physicalQty,
      systemQty,
      storeNotes: safeText(entry.storeNotes, 1200),
    });
  }
  return { items };
}
