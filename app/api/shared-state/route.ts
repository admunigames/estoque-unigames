import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;

const MAX_VALUE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();
const TASK_KEY_PATTERN = /^tarefas:(\d{4}-\d{2}-\d{2})$/;

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
    /^tarefas:\d{4}-\d{2}-\d{2}$/.test(key) ||
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

function authenticatedUserId(request: Request): string {
  const value = (request.headers.get("x-unigames-user-id") || "").trim();
  return /^[a-z0-9._-]{3,80}$/i.test(value) ? value : "";
}

function scopedStateKey(request: Request, key: string): string {
  const taskMatch = TASK_KEY_PATTERN.exec(key);
  if (!taskMatch) return key;
  const userId = authenticatedUserId(request);
  if (!userId) throw new Error("USUÁRIO NÃO IDENTIFICADO");
  return `tarefas:${userId}:${taskMatch[1]}`;
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

  const url = new URL(request.url);
  if (url.searchParams.get("scope") === "task-agenda") {
    const from = (url.searchParams.get("from") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return jsonResponse({ error: "DATA INICIAL INVÁLIDA." }, 400);
    }
    try {
      const database = await getD1();
      const userId = authenticatedUserId(request);
      if (!userId) return jsonResponse({ error: "USUÁRIO NÃO IDENTIFICADO." }, 401);
      const prefix = `tarefas:${userId}:`;
      const result = await database
        .prepare(
          `SELECT state_key AS stateKey, value_json AS value
           FROM shared_state
           WHERE substr(state_key, 1, length(?1)) = ?1 AND state_key > ?2
           ORDER BY state_key ASC`,
        )
        .bind(prefix, `${prefix}${from}`)
        .all<{ stateKey: string; value: string }>();
      const items = (result.results ?? []).map((item) => ({
        ...item,
        stateKey: `tarefas:${String(item.stateKey || "").slice(prefix.length)}`,
      }));

      // A conta principal mantém acesso às tarefas criadas antes da separação
      // por usuário. Quando um dia antigo for salvo novamente, ele passa
      // automaticamente para a chave privada da conta principal.
      if (userId === "env-admin") {
        const legacy = await database
          .prepare(
            `SELECT state_key AS stateKey, value_json AS value
             FROM shared_state
             WHERE length(state_key) = 18
               AND state_key LIKE 'tarefas:____-__-__'
               AND state_key > ?1
             ORDER BY state_key ASC`,
          )
          .bind(`tarefas:${from}`)
          .all<{ stateKey: string; value: string }>();
        const existingDates = new Set(items.map((item) => String(item.stateKey)));
        for (const item of legacy.results ?? []) {
          if (!existingDates.has(String(item.stateKey))) items.push(item);
        }
        items.sort((left, right) => String(left.stateKey).localeCompare(String(right.stateKey)));
      }

      return jsonResponse({ items });
    } catch {
      return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A AGENDA." }, 500);
    }
  }

  const key = stateKey(request);
  if (!validStateKey(key)) return jsonResponse({ error: "CHAVE INVÁLIDA." }, 400);

  try {
    const resolvedKey = scopedStateKey(request, key);
    let row = await readState(resolvedKey);
    if (!row && authenticatedUserId(request) === "env-admin" && TASK_KEY_PATTERN.test(key)) {
      row = await readState(key);
    }
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
    const resolvedKey = scopedStateKey(request, key);
    if (ifAbsent) {
      await database
        .prepare(
          "INSERT OR IGNORE INTO shared_state (state_key, value_json, version, updated_at) VALUES (?1, ?2, 1, ?3)",
        )
        .bind(resolvedKey, value, now)
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
        .bind(resolvedKey, value, now)
        .run();
    }

    const row = await readState(resolvedKey);
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
    const resolvedKey = scopedStateKey(request, key);
    await database
      .prepare("DELETE FROM shared_state WHERE state_key = ?1")
      .bind(resolvedKey)
      .run();
    return jsonResponse({ deleted: true });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APAGAR DO BANCO COMPARTILHADO." }, 500);
  }
}
