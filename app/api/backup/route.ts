import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;

const MAX_VALUE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();
const STATIC_BACKUP_KEYS = [
  "companies_list",
  "products_catalog:standard",
  "products_catalog:pa",
  "products_catalog",
  "puxadas:data",
  "report41:company-stock",
];

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : {};
}

function jsonResponse(body: JsonMap, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// Exportar/restaurar backup mexe em todos os dados compartilhados de uma
// vez só, então fica restrito à conta raiz (env-admin), diferente das
// demais rotas de shared-state que qualquer usuário autorizado usa no
// dia a dia. Ver worker/index.ts (isAllowed) para o mesmo gate aplicado
// antes da requisição chegar aqui.
function isEnvAdmin(request: Request): boolean {
  return (request.headers.get("x-unigames-user-id") || "").trim() === "env-admin";
}

function validBackupKey(key: string): boolean {
  return (
    STATIC_BACKUP_KEYS.includes(key) ||
    /^report41:store:c[a-z0-9]{6,40}$/i.test(key) ||
    /^estoque:c[a-z0-9]{6,40}$/i.test(key)
  );
}

function validJsonValue(value: unknown): value is string {
  if (typeof value !== "string" || encoder.encode(value).byteLength > MAX_VALUE_BYTES) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function companyIdsFromCompaniesList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((company) => (company && typeof company === "object" ? String((company as JsonMap).id || "") : ""))
      .filter((id) => /^c[a-z0-9]{6,40}$/i.test(id));
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!isEnvAdmin(request)) {
    return jsonResponse({ error: "APENAS O ADMINISTRADOR PRINCIPAL PODE EXPORTAR O BACKUP." }, 403);
  }

  try {
    const database = await getD1();
    const companiesRow = await database
      .prepare("SELECT value_json AS value FROM shared_state WHERE state_key = ?1")
      .bind("companies_list")
      .first<{ value: string }>();
    const companyIds = companyIdsFromCompaniesList(companiesRow?.value);

    const keys = new Set(STATIC_BACKUP_KEYS);
    for (const companyId of companyIds) {
      keys.add(`estoque:${companyId}`);
      keys.add(`report41:store:${companyId}`);
    }

    const values: JsonMap = {};
    for (const key of keys) {
      const row = await database
        .prepare("SELECT value_json AS value FROM shared_state WHERE state_key = ?1")
        .bind(key)
        .first<{ value: string }>();
      if (row?.value !== undefined && row?.value !== null) values[key] = row.value;
    }

    return jsonResponse({
      app: "ESTOQUE_SHARED_BACKUP",
      version: 2,
      exportedAt: new Date().toISOString(),
      values,
    });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GERAR O BACKUP." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!isEnvAdmin(request)) {
    return jsonResponse({ error: "APENAS O ADMINISTRADOR PRINCIPAL PODE RESTAURAR O BACKUP." }, 403);
  }

  try {
    const payload = asRecord(await request.json());
    const supportedBackup = payload.app === "ESTOQUE_SHARED_BACKUP" || payload.app === "ESTOQUE_IOS_BACKUP";
    const values = asRecord(payload.values);
    if (!supportedBackup || !Object.keys(values).length) {
      return jsonResponse({ error: "ARQUIVO DE BACKUP INVÁLIDO." }, 400);
    }

    const entries = Object.entries(values).filter(
      ([key, value]) => validBackupKey(key) && validJsonValue(value),
    );
    if (!entries.length) {
      return jsonResponse({ error: "ARQUIVO DE BACKUP INVÁLIDO." }, 400);
    }

    const now = new Date().toISOString();
    const database = await getD1();
    await database.batch(
      entries.map(([key, value]) =>
        database
          .prepare(
            `INSERT INTO shared_state (state_key, value_json, version, updated_at)
             VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(state_key) DO UPDATE SET
               value_json = excluded.value_json,
               version = shared_state.version + 1,
               updated_at = excluded.updated_at`,
          )
          .bind(key, value, now),
      ),
    );

    return jsonResponse({ restored: entries.length });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL RESTAURAR O BACKUP." }, 500);
  }
}
