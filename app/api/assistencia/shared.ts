import { hasCompany } from "../../lib/access-scope";
import { equipmentSubtotal, parseSavedObservations, type ParsedQuote } from "../../lib/assistencia";

// Base comum de Assistência > Orçamentos — mesmo estilo de
// app/api/divergences/shared.ts: identidade só pelos headers x-unigames-*
// (setados pelo Worker) e sameOrigin em toda escrita. Permissão ÚNICA
// assistencia:manage (admin sempre pode) e SEM escopo por loja: quem tem a
// permissão escolhe qualquer loja e vê o histórico de todas, mesmo com loja
// vinculada no login (decisão do usuário).

export type JsonMap = Record<string, unknown>;

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export const FORBIDDEN = "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR A ASSISTÊNCIA.";
export const NOT_FOUND = "ORÇAMENTO NÃO ENCONTRADO.";

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

export function canManage(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("assistencia:manage");
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

/** Nome da loja no Cadastro de Lojas (shared_state companies_list), ou "" se não existir. */
export async function companyName(database: D1Database, companyId: string) {
  if (!hasCompany(companyId)) return "";
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

export function routeParam(value: unknown) {
  return safeText(value, 80);
}

export function osConflictMessage(osNumber: string) {
  return `JÁ EXISTE UM ORÇAMENTO COM A OS ${osNumber}.`;
}

export type QuoteRow = {
  id: string;
  osNumber: string;
  companyId: string;
  companyName: string;
  entryDate: string;
  clientName: string;
  clientCpf: string;
  clientPhone: string;
  clientAddress: string;
  observations: string;
  extraNotes: string;
  totalCents: number;
  createdByName: string;
  createdAt: string;
  updatedByName: string;
  updatedAt: string;
};

export const QUOTE_SELECT = `
  SELECT id, os_number AS osNumber, company_id AS companyId, company_name AS companyName,
         entry_date AS entryDate, client_name AS clientName, client_cpf AS clientCpf,
         client_phone AS clientPhone, client_address AS clientAddress, observations,
         extra_notes AS extraNotes, total_cents AS totalCents, created_by_name AS createdByName,
         created_at AS createdAt, updated_by_name AS updatedByName, updated_at AS updatedAt
  FROM assist_quotes`;

type ItemRow = {
  equipmentIndex: number;
  category: string;
  device: string;
  serialNumber: string;
  service: string;
  defectName: string;
  description: string;
  quantity: number;
  unitCents: number;
};

export async function loadQuote(database: D1Database, id: string) {
  return database.prepare(`${QUOTE_SELECT} WHERE id=?1 LIMIT 1`).bind(id).first<QuoteRow>();
}

/** Orçamento + equipamentos (linhas agrupadas por equipamento), só texto/números. */
export async function loadQuoteDetail(database: D1Database, row: QuoteRow) {
  const result = await database
    .prepare(
      `SELECT equipment_index AS equipmentIndex, category, device, serial_number AS serialNumber, service,
              defect_name AS defectName, description, quantity, unit_cents AS unitCents
       FROM assist_quote_items WHERE quote_id=?1 ORDER BY equipment_index, sort_order, id`,
    )
    .bind(row.id)
    .all<ItemRow>();
  const equipments: Array<{
    category: string;
    device: string;
    serialNumber: string;
    service: string;
    subtotalCents: number;
    lines: Array<{ defectName: string; description: string; quantity: number; unitCents: number; totalCents: number }>;
  }> = [];
  const byIndex = new Map<number, (typeof equipments)[number]>();
  for (const item of result.results ?? []) {
    const index = Number(item.equipmentIndex) || 0;
    let equipment = byIndex.get(index);
    if (!equipment) {
      equipment = {
        category: String(item.category || ""),
        device: String(item.device || ""),
        serialNumber: String(item.serialNumber || ""),
        service: String(item.service || ""),
        subtotalCents: 0,
        lines: [],
      };
      byIndex.set(index, equipment);
      equipments.push(equipment);
    }
    const quantity = Number(item.quantity) || 0;
    const unitCents = Number(item.unitCents) || 0;
    equipment.lines.push({
      defectName: String(item.defectName || ""),
      description: String(item.description || ""),
      quantity,
      unitCents,
      totalCents: quantity * unitCents,
    });
  }
  for (const equipment of equipments) equipment.subtotalCents = equipmentSubtotal(equipment);
  return {
    quote: { ...normalizeQuote(row), observations: parseSavedObservations(row.observations) },
    equipments,
  };
}

export function normalizeQuote(row: QuoteRow) {
  return { ...row, totalCents: Number(row.totalCents) || 0 };
}

/** INSERTs das linhas do orçamento (um por defeito/item avulso), na ordem digitada. */
export function itemStatements(database: D1Database, quoteId: string, quote: ParsedQuote) {
  const statements: D1PreparedStatement[] = [];
  for (const [equipmentPosition, equipment] of quote.equipments.entries()) {
    for (const [linePosition, line] of equipment.lines.entries()) {
      statements.push(
        database
          .prepare(
            `INSERT INTO assist_quote_items
              (id, quote_id, equipment_index, category, device, serial_number, service, defect_name,
               description, quantity, unit_cents, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(
            crypto.randomUUID(),
            quoteId,
            equipmentPosition + 1,
            equipment.category,
            equipment.device,
            equipment.serialNumber,
            equipment.service,
            line.defectName,
            line.description,
            line.quantity,
            line.unitCents,
            linePosition,
          ),
      );
    }
  }
  return statements;
}

export async function osTaken(database: D1Database, osNumber: string, exceptId = "") {
  const row = exceptId
    ? await database
        .prepare("SELECT id FROM assist_quotes WHERE os_number=?1 AND id<>?2 LIMIT 1")
        .bind(osNumber, exceptId)
        .first<{ id: string }>()
    : await database.prepare("SELECT id FROM assist_quotes WHERE os_number=?1 LIMIT 1").bind(osNumber).first<{ id: string }>();
  return Boolean(row);
}
