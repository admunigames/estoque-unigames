import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;

const MAX_VALUE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : {};
}

function validStateKey(key: string): boolean {
  return (
    key === "companies_list" ||
    key === "products_catalog" ||
    key === "products_catalog:standard" ||
    key === "products_catalog:pa" ||
    key === "puxadas:data" ||
    key === "__shared_health__" ||
    /^estoque:c[a-z0-9]{6,40}$/i.test(key)
  );
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

function stateKey(request: Request): string {
  return (new URL(request.url).searchParams.get("key") || "").trim();
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

async function readState(key: string) {
  const database = await getD1();
  return database
    .prepare(
      "SELECT value_json AS value, version, updated_at AS updatedAt FROM shared_state WHERE state_key = ?1",
    )
    .bind(key)
    .first<{ value: string; version: number; updatedAt: string }>();
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  const key = stateKey(request);
  if (!validStateKey(key)) return jsonResponse({ error: "CHAVE INVÁLIDA." }, 400);

  try {
    const row = await readState(key);
    return jsonResponse({
      value: row?.value ?? null,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
    });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LER O BANCO COMPARTILHADO." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const payload = asRecord(await request.json());
    const key = typeof payload.key === "string" ? payload.key.trim() : "";
    const value = payload.value;
    const ifAbsent = payload.ifAbsent === true;
    if (!validStateKey(key)) return jsonResponse({ error: "CHAVE INVÁLIDA." }, 400);
    if (!validJsonValue(value)) {
      return jsonResponse({ error: "DADOS INVÁLIDOS OU MAIORES QUE 5 MB." }, 400);
    }

    const now = new Date().toISOString();
    const database = await getD1();
    if (ifAbsent) {
      await database
        .prepare(
          "INSERT OR IGNORE INTO shared_state (state_key, value_json, version, updated_at) VALUES (?1, ?2, 1, ?3)",
        )
        .bind(key, value, now)
        .run();
    } else {
      await database
        .prepare(
          `INSERT INTO shared_state (state_key, value_json, version, updated_at)
           VALUES (?1, ?2, 1, ?3)
           ON CONFLICT(state_key) DO UPDATE SET
             value_json = excluded.value_json,
             version = shared_state.version + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(key, value, now)
        .run();
    }

    const row = await readState(key);
    return jsonResponse({
      value: row?.value ?? value,
      version: row?.version ?? 1,
      updatedAt: row?.updatedAt ?? now,
    });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR NO BANCO COMPARTILHADO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  const key = stateKey(request);
  if (!validStateKey(key)) return jsonResponse({ error: "CHAVE INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    await database
      .prepare("DELETE FROM shared_state WHERE state_key = ?1")
      .bind(key)
      .run();
    return jsonResponse({ deleted: true });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APAGAR DO BANCO COMPARTILHADO." }, 500);
  }
}
