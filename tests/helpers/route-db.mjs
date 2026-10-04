import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Banco fictício para testar as rotas reais de app/api: troca o getD1() por
// um SQLite em memória com as tabelas geradas a partir do db/schema.ts (só
// colunas, chave primária, defaults e índices únicos) e o
// `cloudflare:workers` por um R2 falso. Mesma técnica de
// tests/store-scope.test.mjs, reaproveitável pelos módulos do Financeiro.
//
//   const db = await setupRouteDb(["tabela_a", "tabela_b"]);
//   const route = await import("../app/api/.../route.ts");  // DEPOIS do setup

const hooks = `
const DB_STUB = "export async function getD1() { return globalThis.__routeTestDb; }";
const CF_STUB = "export const env = { get UPLOADS() { return globalThis.__routeTestBucket; } };";
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.\\/)+db$/.test(specifier) && context.parentURL && context.parentURL.includes("/app/api/")) {
    return { url: "data:text/javascript," + encodeURIComponent(DB_STUB), shortCircuit: true };
  }
  if (specifier === "cloudflare:workers") {
    return { url: "data:text/javascript," + encodeURIComponent(CF_STUB), shortCircuit: true };
  }
  if (specifier.startsWith(".") && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith("file:")) {
    try {
      return await next(specifier + ".ts", context);
    } catch {
      // segue para a resolução normal
    }
  }
  return next(specifier, context);
}
`;

const schemaSource = await readFile(new URL("../../db/schema.ts", import.meta.url), "utf8");

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === "{" || source[index] === "(") depth++;
    if (source[index] === "}" || source[index] === ")") depth--;
    if (depth === 0) return index;
  }
  throw new Error("chave sem par no schema");
}

function sqliteDefault(raw) {
  if (!raw) return "";
  if (raw.startsWith("sql`")) return " DEFAULT CURRENT_TIMESTAMP";
  if (raw.startsWith('"')) return ` DEFAULT '${raw.slice(1, -1).replace(/'/g, "''")}'`;
  if (raw === "true") return " DEFAULT 1";
  if (raw === "false") return " DEFAULT 0";
  return ` DEFAULT ${raw}`;
}

export function createTableSql(table) {
  const start = schemaSource.search(new RegExp(`pgTable\\(\\s*"${table}"`));
  assert.notEqual(start, -1, `tabela ${table} não encontrada em db/schema.ts`);
  const open = schemaSource.indexOf("(", start);
  const block = schemaSource.slice(open, matchingBrace(schemaSource, open));
  const columnsOpen = block.indexOf("{");
  const columnsBlock = block.slice(columnsOpen, matchingBrace(block, columnsOpen) + 1);
  const fieldToColumn = new Map();
  const columns = [];
  const columnPattern = /(\w+):\s*(?:text|integer|boolean|real|doublePrecision|bigint|numeric|timestamp|jsonb)\("([a-z0-9_]+)"[^)]*\)([^\n]*)/g;
  for (const [, field, column, chain] of columnsBlock.matchAll(columnPattern)) {
    fieldToColumn.set(field, column);
    const defaultMatch = /\.default\(("[^"]*"|-?\d+(?:\.\d+)?|true|false|sql`[^`]*`)\)/.exec(chain);
    columns.push(`"${column}"${chain.includes(".primaryKey()") ? " PRIMARY KEY" : ""}${sqliteDefault(defaultMatch?.[1])}`);
  }
  const indexes = [];
  for (const [, name, fields] of block.matchAll(/uniqueIndex\("([^"]+)"\)\.on\(([^)]*)\)/g)) {
    const cols = [...fields.matchAll(/table\.(\w+)/g)].map(([, field]) => `"${fieldToColumn.get(field)}"`);
    indexes.push(`CREATE UNIQUE INDEX "${name}" ON "${table}" (${cols.join(", ")});`);
  }
  return `CREATE TABLE "${table}" (${columns.join(", ")});\n${indexes.join("\n")}`;
}

export function createFakeD1(tables) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(tables.map(createTableSql).join("\n"));

  function statement(text) {
    // node:sqlite antigo (Node 22.13 do CI) não liga "?1": converte para "?".
    const order = [];
    const sql = text.replace(/\?(\d+)/g, (_match, index) => {
      order.push(Number(index) - 1);
      return "?";
    });
    let params = [];
    const prepared = {
      bind(...values) {
        params = order.length ? order.map((index) => values[index]) : values;
        return prepared;
      },
      execute() {
        return sqlite.prepare(sql).run(...params);
      },
      async run() {
        prepared.execute();
        return { success: true };
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
    };
    return prepared;
  }

  return {
    sqlite,
    prepare: statement,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const item of statements) item.execute();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
    insert(table, row) {
      const columns = Object.keys(row);
      sqlite
        .prepare(`INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...Object.values(row));
    },
  };
}

export async function setupRouteDb(tables) {
  register("data:text/javascript," + encodeURIComponent(hooks));
  const db = createFakeD1(tables);
  const deletedKeys = [];
  globalThis.__routeTestDb = db;
  globalThis.__routeTestBucket = { deletedKeys, async delete(keys) { deletedKeys.push(...[].concat(keys)); } };
  return db;
}

/** Chama um handler de rota como um login (headers x-unigames-* do Worker). */
export function callRoute(handler, user, method, path, body, params = {}) {
  return handler(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        "x-unigames-user-id": user.id,
        "x-unigames-display-name": encodeURIComponent(user.name || user.id.toUpperCase()),
        "x-unigames-role": user.role || "user",
        "x-unigames-company-id": user.companyId || "",
        "x-unigames-permissions": (user.permissions || []).join(","),
        "sec-fetch-site": "same-origin",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
}
