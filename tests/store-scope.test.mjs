import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Escopo por loja em TODOS os módulos de pedidos/solicitações (regra única de
// app/lib/access-scope.ts): login COM loja vinculada só vê/age na própria
// loja — sem exceção por setor, grupo ou permissão; login SEM loja com a
// permissão do módulo (ou admin) vê todas. Carrega as rotas reais de
// app/api/** trocando só o getD1() por um SQLite em memória (tabelas geradas
// a partir de db/schema.ts) e o `cloudflare:workers` por um R2 falso.
const hooks = `
const DB_STUB = "export async function getD1() { return globalThis.__storeScopeTestDb; }";
const CF_STUB = "export const env = { get UPLOADS() { return globalThis.__storeScopeTestBucket; } };";
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
register("data:text/javascript," + encodeURIComponent(hooks));

const STORE_A = "criomar01";
const STORE_B = "cguarar01";

// ---------------------------------------------------------------------------
// Banco fictício: CREATE TABLE a partir do db/schema.ts (só colunas, chave
// primária, defaults e índices únicos — o suficiente para as rotas).
// ---------------------------------------------------------------------------
const schemaSource = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

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

function createTableSql(table) {
  const start = schemaSource.search(new RegExp(`pgTable\\(\\s*"${table}"`));
  assert.notEqual(start, -1, `tabela ${table} não encontrada em db/schema.ts`);
  const open = schemaSource.indexOf("(", start);
  const end = matchingBrace(schemaSource, open);
  const block = schemaSource.slice(open, end);
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

const TABLES = [
  "shared_state", "requested_inputs", "defective_outputs", "pdv_change_requests", "os_notes",
  "captured_products", "loan_devices", "loan_requests", "loan_request_updates",
  "supply_categories", "supply_products", "supply_items", "supply_request_events",
  "supply_requests", "supply_request_items", "supply_stock_movements", "supply_missing_marks",
  "divergence_requests", "divergence_items", "divergence_item_events",
];

function createFakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(TABLES.map(createTableSql).join("\n"));
  sqlite
    .prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)")
    .run(JSON.stringify([{ id: STORE_A, name: "RIOMAR" }, { id: STORE_B, name: "GUARARAPES" }]));

  function statement(text) {
    // node:sqlite antigo (Node 22.13 do CI) não liga parâmetros posicionais
    // a placeholders "?1": converte para "?" na ordem de uso.
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
  };
}

function createFakeBucket() {
  const objects = new Map();
  const wrap = (key, value) => ({
    key,
    size: typeof value === "string" ? value.length : value.byteLength,
    httpMetadata: { contentType: "application/octet-stream" },
    httpEtag: '"etag"',
    body: value,
    async text() { return typeof value === "string" ? value : Buffer.from(value).toString("utf8"); },
    async arrayBuffer() { return typeof value === "string" ? Buffer.from(value) : value; },
  });
  return {
    objects,
    async put(key, value) { objects.set(key, value); return wrap(key, value); },
    async get(key) { return objects.has(key) ? wrap(key, objects.get(key)) : null; },
    async head(key) { return objects.has(key) ? wrap(key, objects.get(key)) : null; },
    async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
    async list({ prefix = "" } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const db = createFakeD1();
globalThis.__storeScopeTestDb = db;
globalThis.__storeScopeTestBucket = createFakeBucket();

const inputs = await import("../app/api/inputs/route.ts");
const outputs = await import("../app/api/outputs/route.ts");
const pdv = await import("../app/api/pdv-requests/route.ts");
const osNotes = await import("../app/api/os-notes/route.ts");
const osNoteAttachment = await import("../app/api/os-notes/attachment/route.ts");
const osNoteFile = await import("../app/api/os-notes/file/route.ts");
const captures = await import("../app/api/captures/route.ts");
const capturePhoto = await import("../app/api/captures/photo/route.ts");
const loanRequests = await import("../app/api/loans/requests/route.ts");
const loanComments = await import("../app/api/loans/requests/comments/route.ts");
const loanDevices = await import("../app/api/loans/devices/route.ts");
const supplies = await import("../app/api/supplies/route.ts");
const supplyRequests = await import("../app/api/supplies/requests/route.ts");
const supplyStock = await import("../app/api/supplies/stock/route.ts");
const supplyDashboard = await import("../app/api/supplies/dashboard/route.ts");
const divergences = await import("../app/api/divergences/route.ts");
const divergenceDetail = await import("../app/api/divergences/[id]/route.ts");
const accessScope = await import("../app/lib/access-scope.ts");

const ORIGIN = "http://127.0.0.1";
const ADMIN = { id: "admin", role: "admin", companyId: "", permissions: [] };

function headersFor(user, extra = {}) {
  return {
    "x-unigames-user-id": user.id,
    "x-unigames-display-name": encodeURIComponent(user.name || user.id.toUpperCase()),
    "x-unigames-role": user.role || "user",
    "x-unigames-company-id": user.companyId || "",
    "x-unigames-sector": user.sector || "",
    "x-unigames-permissions": (user.permissions || []).join(","),
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function call(handler, user, method, path, body, params = {}) {
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: headersFor(user, body === undefined ? {} : { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(request, { params: Promise.resolve(params) });
}

async function json(response) {
  return response.json().catch(() => ({}));
}

// Os três perfis de cada módulo: loja A, loja A no setor Administrativo
// (regressão do atalho do setor) e equipe central sem loja.
function profiles(moduleKey, permissions) {
  const perms = permissions.map((action) => `${moduleKey}:${action}`);
  return {
    storeA: { id: `${moduleKey}-loja-a`, companyId: STORE_A, permissions: perms },
    storeAAdministrative: { id: `${moduleKey}-loja-a-adm`, companyId: STORE_A, sector: "administrative", permissions: perms },
    storeB: { id: `${moduleKey}-loja-b`, companyId: STORE_B, permissions: perms },
    central: { id: `${moduleKey}-central`, companyId: "", sector: "administrative", permissions: perms },
  };
}

function insert(table, row) {
  const columns = Object.keys(row);
  db.sqlite
    .prepare(`INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

function companiesOf(rows) {
  return [...new Set(rows.map((row) => row.companyId ?? row.originCompanyId))].sort();
}

test("access-scope: canActOnStore só libera a própria loja para login com loja", () => {
  const store = { role: "user", companyId: STORE_A, permissions: ["inputs:delete"] };
  const central = { role: "user", companyId: "", permissions: ["inputs:delete"] };
  assert.equal(accessScope.canActOnStore(store, "inputs:delete", STORE_A), true);
  assert.equal(accessScope.canActOnStore(store, "inputs:delete", STORE_B), false);
  assert.equal(accessScope.canActOnStore(store, "inputs:delete", ""), false);
  assert.equal(accessScope.canActOnStore(central, "inputs:delete", STORE_B), true);
  assert.equal(accessScope.canActOnStore(central, "inputs:complete", STORE_B), false);
  assert.equal(accessScope.canActOnStore(ADMIN, "qualquer", STORE_B), true);
});

for (const [name, route, table, body] of [
  ["Entradas", inputs, "requested_inputs", { quantity: 1, productName: "CONTROLE", responsibleName: "ANA", reason: "TROCA" }],
  ["Saídas", outputs, "defective_outputs", { quantity: 1, productName: "CONTROLE", responsibleName: "ANA", defect: "DRIFT" }],
]) {
  const moduleName = table === "requested_inputs" ? "inputs" : "outputs";
  test(`${name}: loja A só vê/conclui/exclui as próprias; setor Administrativo com loja não amplia; sem loja vê todas`, async () => {
    const { storeA, storeAAdministrative, storeB, central } = profiles(moduleName, ["view", "create", "complete", "delete"]);
    const base = `/api/${moduleName}`;

    // POST da loja B tentando gravar na loja A → grava na própria (B).
    const createdB = await call(route.POST, storeB, "POST", base, { ...body, companyId: STORE_A });
    assert.equal(createdB.status, 201);
    const idB = (await json(createdB)).id;
    assert.equal(db.sqlite.prepare(`SELECT company_id AS c FROM ${table} WHERE id=?`).get(idB).c, STORE_B);
    const createdA = await call(route.POST, storeA, "POST", base, body);
    const idA = (await json(createdA)).id;
    // Setor Administrativo com loja também não escolhe outra loja.
    const createdAdm = await call(route.POST, storeAAdministrative, "POST", base, { ...body, companyId: STORE_B });
    const idAdm = (await json(createdAdm)).id;
    assert.equal(db.sqlite.prepare(`SELECT company_id AS c FROM ${table} WHERE id=?`).get(idAdm).c, STORE_A);

    const key = moduleName;
    for (const user of [storeA, storeAAdministrative]) {
      const list = (await json(await call(route.GET, user, "GET", base)))[key];
      assert.deepEqual(companiesOf(list), [STORE_A], `${name}: ${user.id} só vê a loja A`);
      // Concluir/excluir registro da loja B pelo id → 404 (não revela que existe).
      assert.equal((await call(route.PATCH, user, "PATCH", base, { id: idB })).status, 404);
      assert.equal((await call(route.DELETE, user, "DELETE", base, { id: idB })).status, 404);
    }
    assert.equal(db.sqlite.prepare(`SELECT status FROM ${table} WHERE id=?`).get(idB).status, "requested");

    for (const user of [central, ADMIN]) {
      const list = (await json(await call(route.GET, user, "GET", base)))[key];
      assert.deepEqual(companiesOf(list), [STORE_B, STORE_A].sort());
    }
    // Sem loja: escolhe a loja e conclui/exclui em qualquer uma.
    assert.equal((await call(route.POST, central, "POST", base, body)).status, 400);
    assert.equal((await call(route.POST, central, "POST", base, { ...body, companyId: STORE_B })).status, 201);
    assert.equal((await call(route.PATCH, central, "PATCH", base, { id: idB })).status, 200);
    assert.equal((await call(route.PATCH, storeA, "PATCH", base, { id: idA })).status, 200);
    assert.equal((await call(route.DELETE, central, "DELETE", base, { id: idB })).status, 200);
    assert.equal((await call(route.DELETE, ADMIN, "DELETE", base, { id: idA })).status, 200);
  });
}

test("Alterações PDV: grava a loja, filtra a lista e confere a loja no status/exclusão", async () => {
  const { storeA, storeAAdministrative, storeB, central } = profiles("pdv_requests", ["view", "create", "status", "delete"]);
  const base = "/api/pdv-requests";
  const body = { type: "observation", saleId: "123", requesterName: "ANA", details: { note: "TROCAR OBS" } };

  const createdB = await call(pdv.POST, storeB, "POST", base, { ...body, companyId: STORE_A });
  assert.equal(createdB.status, 201);
  const idB = (await json(createdB)).id;
  const rowB = db.sqlite.prepare("SELECT company_id AS c, company_name AS n FROM pdv_change_requests WHERE id=?").get(idB);
  assert.deepEqual({ ...rowB }, { c: STORE_B, n: "GUARARAPES" });
  const idA = (await json(await call(pdv.POST, storeA, "POST", base, body))).id;
  // Registro antigo sem loja (criado antes da 0079 por login sem loja).
  insert("pdv_change_requests", { id: "pdv-sem-loja", type: "observation", sale_id: "9", details_json: "{}", status: "open", created_by: "x" });

  // Sem loja: LOJA obrigatória no cadastro.
  const missing = await call(pdv.POST, central, "POST", base, body);
  assert.equal(missing.status, 400);
  assert.equal((await json(missing)).error, "ESCOLHA A LOJA.");
  assert.equal((await call(pdv.POST, central, "POST", base, { ...body, companyId: STORE_B })).status, 201);

  for (const user of [storeA, storeAAdministrative]) {
    const payload = await json(await call(pdv.GET, user, "GET", base));
    assert.equal(payload.allStores, false);
    assert.deepEqual(companiesOf(payload.requests), [STORE_A]);
    assert.ok(payload.requests.some((row) => row.id === idA && row.companyName === "RIOMAR"));
    assert.equal((await call(pdv.PATCH, user, "PATCH", base, { id: idB, status: "done" })).status, 404);
    assert.equal((await call(pdv.PATCH, user, "PATCH", base, { id: "pdv-sem-loja", status: "done" })).status, 404);
    assert.equal((await call(pdv.DELETE, user, "DELETE", `${base}?id=${idB}`)).status, 404);
  }
  assert.equal(db.sqlite.prepare("SELECT status FROM pdv_change_requests WHERE id=?").get(idB).status, "open");

  for (const user of [central, ADMIN]) {
    const payload = await json(await call(pdv.GET, user, "GET", base));
    assert.equal(payload.allStores, true);
    assert.deepEqual(companiesOf(payload.requests), ["", STORE_B, STORE_A].sort());
  }
  // Central só com "status" (sem view) continua vendo todas.
  const statusOnly = { id: "pdv-status", companyId: "", permissions: ["pdv_requests:status"] };
  assert.equal((await json(await call(pdv.GET, statusOnly, "GET", base))).allStores, true);
  assert.equal((await call(pdv.PATCH, statusOnly, "PATCH", base, { id: idB, status: "done" })).status, 200);
  assert.equal((await call(pdv.PATCH, storeA, "PATCH", base, { id: idA, status: "doubt" })).status, 200);
  assert.equal((await call(pdv.DELETE, central, "DELETE", `${base}?id=pdv-sem-loja`)).status, 200);
  assert.equal((await call(pdv.DELETE, storeA, "DELETE", `${base}?id=${idA}`)).status, 200);
});

test("Alterações PDV: migration 0079 cria a loja e faz o backfill pelo login de quem criou", async () => {
  const migration = await readFile(new URL("../drizzle/0079_pdv_requests_loja.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "company_id" text DEFAULT '' NOT NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "company_name" text DEFAULT '' NOT NULL/);
  assert.match(migration, /pdv_change_requests_company_status_created_idx" ON "pdv_change_requests" USING btree \("company_id","status","created_at"\)/);
  assert.match(migration, /FROM "app_users" AS u\s+WHERE u\."id" = r\."created_by"/);
  assert.match(migration, /s\."state_key" = 'companies_list'/);
});

test("Notas de O.S.: loja A não exclui, anexa nem baixa nota de outra loja", async () => {
  const { storeA, storeAAdministrative, storeB, central } = profiles("os_notes", ["view", "create", "attach", "delete"]);
  const base = "/api/os-notes";
  const idB = (await json(await call(osNotes.POST, storeB, "POST", base, { osId: "77", requesterName: "BIA", companyId: STORE_A }))).id;
  assert.equal(db.sqlite.prepare("SELECT company_id AS c FROM os_notes WHERE id=?").get(idB).c, STORE_B);
  const idA = (await json(await call(osNotes.POST, storeA, "POST", base, { osId: "78", requesterName: "ANA" }))).id;
  db.sqlite.prepare("UPDATE os_notes SET r2_key='os-notes/b/nota.pdf', file_name='nota.pdf', status='attached' WHERE id=?").run(idB);
  await globalThis.__storeScopeTestBucket.put("os-notes/b/nota.pdf", "PDF");
  const attach = (user, id) => call(osNoteAttachment.POST, user, "POST", `${base}/attachment`, {
    action: "create", id, fileName: "nota.pdf", contentType: "application/pdf", fileSize: 3, numberOfParts: 1,
  });

  for (const user of [storeA, storeAAdministrative]) {
    const notes = (await json(await call(osNotes.GET, user, "GET", `${base}?companyId=${STORE_B}`))).notes;
    assert.deepEqual(companiesOf(notes), [STORE_A]);
    assert.equal((await attach(user, idB)).status, 404);
    assert.equal((await call(osNotes.DELETE, user, "DELETE", `${base}?id=${idB}`)).status, 404);
    assert.notEqual((await call(osNoteFile.GET, user, "GET", `${base}/file?id=${idB}`)).status, 200);
  }
  assert.ok(db.sqlite.prepare("SELECT id FROM os_notes WHERE id=?").get(idB));
  assert.equal((await attach(storeA, idA)).status, 201);
  for (const user of [central, ADMIN]) {
    const notes = (await json(await call(osNotes.GET, user, "GET", base))).notes;
    assert.deepEqual(companiesOf(notes), [STORE_B, STORE_A].sort());
    assert.equal((await attach(user, idB)).status, 201);
    assert.equal((await call(osNoteFile.GET, user, "GET", `${base}/file?id=${idB}`)).status, 200);
  }
  assert.equal((await call(osNotes.DELETE, central, "DELETE", `${base}?id=${idB}`)).status, 200);
});

test("Captação: loja A (mesmo com receber/atribuir/excluir) não vê nem age em captação da loja B", async () => {
  const perms = ["view", "create", "receive", "assign", "delete"];
  const { storeA, storeAAdministrative } = profiles("captures", perms);
  const central = { id: "assistencia", companyId: "", sector: "assistance", permissions: ["captures:receive"] };
  const manager = { id: "gestor-captacao", companyId: "", permissions: ["captures:view", "captures:assign", "captures:delete"] };
  const row = (id, company, extra = {}) => insert("captured_products", {
    id, category: "console", product_name: "PS4", origin_company_id: company,
    origin_company_name: company === STORE_A ? "RIOMAR" : "GUARARAPES", captured_value_cents: 50000,
    photo_key: `captures/${id}.jpg`, status: "submitted", created_by: "x", ...extra,
  });
  row("cap-a", STORE_A);
  row("cap-b", STORE_B);
  row("cap-b-ready", STORE_B, { status: "ready" });
  await globalThis.__storeScopeTestBucket.put("captures/cap-b.jpg", "JPG");

  for (const user of [storeA, storeAAdministrative]) {
    const list = (await json(await call(captures.GET, user, "GET", "/api/captures"))).captures;
    assert.deepEqual(companiesOf(list), [STORE_A], `${user.id} só vê a loja A`);
    assert.equal((await call(captures.PATCH, user, "PATCH", "/api/captures", { id: "cap-b", action: "receive" })).status, 404);
    assert.equal((await call(captures.PATCH, user, "PATCH", "/api/captures", {
      id: "cap-b-ready", action: "assign", destinationCompanyId: STORE_A,
    })).status, 404);
    assert.equal((await call(captures.DELETE, user, "DELETE", "/api/captures", { id: "cap-b" })).status, 404);
    assert.equal((await call(capturePhoto.GET, user, "GET", "/api/captures/photo?id=cap-b")).status, 403);
  }
  assert.equal(db.sqlite.prepare("SELECT status FROM captured_products WHERE id='cap-b'").get().status, "submitted");

  // Equipe sem loja: recebe e vê a foto de qualquer loja; gestor atribui/exclui.
  assert.deepEqual(companiesOf((await json(await call(captures.GET, central, "GET", "/api/captures"))).captures), [STORE_B, STORE_A].sort());
  assert.equal((await call(capturePhoto.GET, central, "GET", "/api/captures/photo?id=cap-b")).status, 200);
  assert.equal((await call(captures.PATCH, central, "PATCH", "/api/captures", { id: "cap-b", action: "receive" })).status, 200);
  assert.equal((await call(captures.PATCH, manager, "PATCH", "/api/captures", {
    id: "cap-b-ready", action: "assign", destinationCompanyId: STORE_A,
  })).status, 200);
  assert.equal((await call(captures.DELETE, ADMIN, "DELETE", "/api/captures", { id: "cap-b" })).status, 200);
  assert.equal((await call(captures.DELETE, storeA, "DELETE", "/api/captures", { id: "cap-a" })).status, 200);
});

test("Aparelhos de Empréstimo: gestor com loja só vê/age nas solicitações da própria loja", async () => {
  const perms = ["view", "request", "manage_requests", "edit"];
  const { storeA, storeAAdministrative, central } = profiles("loans", perms);
  insert("loan_devices", { id: "dev-1", name: "IPHONE 11", status: "loaned", current_company_id: STORE_B, current_company_name: "GUARARAPES" });
  insert("loan_devices", { id: "dev-2", name: "IPHONE 12", status: "available" });
  insert("loan_devices", { id: "dev-3", name: "IPHONE 13", status: "loaned", current_company_id: STORE_A, current_company_name: "RIOMAR" });
  const request = (id, company, deviceId, status = "requested") => insert("loan_requests", {
    id, device_id: deviceId, device_name: "IPHONE", company_id: company,
    company_name: company === STORE_A ? "RIOMAR" : "GUARARAPES", responsible_name: "ANA", reason: "TESTE",
    status, created_by: "x",
  });
  request("loan-a", STORE_A, "dev-3");
  request("loan-b", STORE_B, "dev-2");
  const base = "/api/loans/requests";

  for (const user of [storeA, storeAAdministrative]) {
    const list = (await json(await call(loanRequests.GET, user, "GET", base))).requests;
    assert.deepEqual(companiesOf(list), [STORE_A]);
    assert.equal((await call(loanRequests.PATCH, user, "PATCH", base, { id: "loan-b", action: "loan" })).status, 404);
    assert.equal((await call(loanRequests.DELETE, user, "DELETE", base, { id: "loan-b" })).status, 404);
    assert.equal((await call(loanComments.GET, user, "GET", `${base}/comments?requestId=loan-b`)).status, 404);
    assert.equal((await call(loanComments.POST, user, "POST", `${base}/comments`, { requestId: "loan-b", message: "OI" })).status, 404);
    // Catálogo compartilhado, mas sem revelar a LOJA ATUAL de outra loja.
    const devices = (await json(await call(loanDevices.GET, user, "GET", "/api/loans/devices"))).items;
    assert.equal(devices.length, 3);
    assert.equal(devices.find((device) => device.id === "dev-1").currentCompanyName, "OUTRA LOJA");
    assert.equal(devices.find((device) => device.id === "dev-1").currentCompanyId, "");
    assert.equal(devices.find((device) => device.id === "dev-3").currentCompanyName, "RIOMAR");
  }
  assert.equal(db.sqlite.prepare("SELECT status FROM loan_requests WHERE id='loan-b'").get().status, "requested");

  for (const user of [central, ADMIN]) {
    assert.deepEqual(companiesOf((await json(await call(loanRequests.GET, user, "GET", base))).requests), [STORE_B, STORE_A].sort());
    const devices = (await json(await call(loanDevices.GET, user, "GET", "/api/loans/devices"))).items;
    assert.equal(devices.find((device) => device.id === "dev-1").currentCompanyName, "GUARARAPES");
  }
  assert.equal((await call(loanComments.POST, central, "POST", `${base}/comments`, { requestId: "loan-b", message: "SEPARANDO" })).status, 201);
  assert.equal((await call(loanRequests.PATCH, central, "PATCH", base, { id: "loan-b", action: "loan" })).status, 200);
  assert.equal((await call(loanRequests.DELETE, storeA, "DELETE", base, { id: "loan-a" })).status, 200);
});

test("Insumos: loja A não exclui/recebe/separa insumo de outra loja; painel e movimentações só da própria", async () => {
  const perms = ["view", "request", "receive", "stock_in", "stock_out", "delete", "manage_catalog"];
  const { storeA, storeAAdministrative, central } = profiles("supplies", perms);
  insert("supply_categories", { id: "cat-1", name: "LIMPEZA" });
  insert("supply_products", { id: "prod-1", category_id: "cat-1", name: "DETERGENTE", stock_qty: 50, active: 1 });
  const item = (id, company) => insert("supply_items", {
    id, company_id: company, company_name: company === STORE_A ? "RIOMAR" : "GUARARAPES",
    product_name: "DETERGENTE", quantity_text: "2", status: "pending", created_by: "x",
  });
  item("item-a-0001", STORE_A);
  item("item-b-0001", STORE_B);
  insert("supply_request_events", { id: "ev-b", supply_item_id: "item-b-0001", company_id: STORE_B, request_date: "2026-10-03", requested_by: "x" });
  const weekStart = "2026-10-05";
  for (const company of [STORE_A, STORE_B]) {
    insert("supply_requests", { id: `req-${company}`, company_id: company, company_name: company === STORE_A ? "RIOMAR" : "GUARARAPES", week_start: weekStart, status: "open", created_by: "x" });
    insert("supply_request_items", { id: `sri-${company}`, request_id: `req-${company}`, product_id: "prod-1", product_name: "DETERGENTE", category_name: "LIMPEZA", quantity: 2 });
    insert("supply_stock_movements", { id: `mov-${company}`, product_id: "prod-1", type: "out", quantity: 1, reason: "X", responsible_name: "X", company_id: company, created_by: "x" });
  }

  for (const user of [storeA, storeAAdministrative]) {
    const list = await json(await call(supplies.GET, user, "GET", `/api/supplies?companyId=${STORE_B}`));
    assert.deepEqual(companiesOf(list.items), [STORE_A]);
    assert.equal((await call(supplies.DELETE, user, "DELETE", "/api/supplies", { id: "item-b-0001" })).status, 404);
    assert.equal((await call(supplies.PATCH, user, "PATCH", "/api/supplies", { action: "receive", id: "item-b-0001" })).status, 403);
    assert.equal((await call(supplyRequests.PATCH, user, "PATCH", "/api/supplies/requests", { itemId: `sri-${STORE_B}`, quantitySeparated: 1 })).status, 404);
    assert.equal((await call(supplyRequests.DELETE, user, "DELETE", "/api/supplies/requests", { id: `req-${STORE_B}` })).status, 404);
    assert.equal((await call(supplyStock.DELETE, user, "DELETE", "/api/supplies/stock", { id: `mov-${STORE_B}` })).status, 404);
    const movements = (await json(await call(supplyStock.GET, user, "GET", `/api/supplies/stock?companyId=${STORE_B}`))).items;
    assert.deepEqual(companiesOf(movements), [STORE_A]);
    const dashboard = await json(await call(supplyDashboard.GET, user, "GET", `/api/supplies/dashboard?weekStart=${weekStart}`));
    assert.equal(dashboard.weekRequestsTotal, 1);
    assert.deepEqual(dashboard.pendingSeparationRequests.map((row) => row.companyName), ["RIOMAR"]);
    // Fila de separação (todas as lojas) não é oferecida a login com loja.
    const queue = await json(await call(supplyRequests.GET, user, "GET", "/api/supplies/requests?queue=1"));
    assert.ok(!Array.isArray(queue.requests) || queue.requests.every((row) => row.companyId === STORE_A));
  }
  assert.ok(db.sqlite.prepare("SELECT id FROM supply_items WHERE id='item-b-0001'").get());
  assert.equal(db.sqlite.prepare(`SELECT separated FROM supply_request_items WHERE id='sri-${STORE_B}'`).get().separated, 0);

  for (const user of [central, ADMIN]) {
    assert.deepEqual(companiesOf((await json(await call(supplies.GET, user, "GET", "/api/supplies"))).items), [STORE_B, STORE_A].sort());
    const dashboard = await json(await call(supplyDashboard.GET, user, "GET", `/api/supplies/dashboard?weekStart=${weekStart}`));
    assert.equal(dashboard.weekRequestsTotal, 2);
    assert.deepEqual(companiesOf((await json(await call(supplyStock.GET, user, "GET", "/api/supplies/stock"))).items), [STORE_B, STORE_A].sort());
  }
  assert.equal((await call(supplyRequests.PATCH, central, "PATCH", "/api/supplies/requests", { itemId: `sri-${STORE_B}`, quantitySeparated: 1 })).status, 200);
  assert.equal((await call(supplyStock.DELETE, central, "DELETE", "/api/supplies/stock", { id: `mov-${STORE_B}` })).status, 200);
  assert.equal((await call(supplies.DELETE, central, "DELETE", "/api/supplies", { id: "item-b-0001" })).status, 200);
  assert.equal((await call(supplyRequests.DELETE, ADMIN, "DELETE", "/api/supplies/requests", { id: `req-${STORE_B}` })).status, 200);
  assert.equal((await call(supplies.DELETE, storeA, "DELETE", "/api/supplies", { id: "item-a-0001" })).status, 200);
});

test("Divergências: setor Administrativo com loja não vê nem age em pedido de outra loja", async () => {
  const { storeA, storeAAdministrative, storeB, central } = profiles("divergencias", ["view", "create", "edit", "delete"]);
  const items = [{ productCode: "1", productName: "CONTROLE PS5", physicalQty: 1, systemQty: 2 }];
  const idB = (await json(await call(divergences.POST, storeB, "POST", "/api/divergences", { items, companyId: STORE_A }))).id;
  assert.equal(db.sqlite.prepare("SELECT company_id AS c FROM divergence_requests WHERE id=?").get(idB).c, STORE_B);
  const idA = (await json(await call(divergences.POST, storeAAdministrative, "POST", "/api/divergences", { items, companyId: STORE_B }))).id;
  assert.equal(db.sqlite.prepare("SELECT company_id AS c FROM divergence_requests WHERE id=?").get(idA).c, STORE_A);

  for (const user of [storeA, storeAAdministrative]) {
    const list = await json(await call(divergences.GET, user, "GET", `/api/divergences?companyId=${STORE_B}`));
    assert.equal(list.allStores, false);
    assert.deepEqual(companiesOf(list.requests), [STORE_A]);
    assert.equal((await call(divergenceDetail.GET, user, "GET", `/api/divergences/${idB}`, undefined, { id: idB })).status, 404);
    assert.equal((await call(divergenceDetail.DELETE, user, "DELETE", `/api/divergences/${idB}`, undefined, { id: idB })).status, 404);
  }
  for (const user of [central, ADMIN]) {
    const list = await json(await call(divergences.GET, user, "GET", "/api/divergences"));
    assert.equal(list.allStores, true);
    assert.deepEqual(companiesOf(list.requests), [STORE_B, STORE_A].sort());
  }
});

test("front: seletor de loja e \"todas as lojas\" sem atalho por setor", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /sector \|\| ''\) === 'administrative'/);
  assert.doesNotMatch(html, /currentSession\.sector === 'administrative'/);
  assert.match(html, /const seesAllStores = canActAcrossStores\('outputs:view'\);/);
  assert.match(html, /const seesAllStores = canActAcrossStores\('inputs:view'\);/);
  // Alterações PDV: LOJA só para quem vê todas.
  assert.match(html, /<div class="field" id="pdvCompanyField" hidden><label for="pdvCompany">LOJA<\/label>/);
  assert.match(html, /const canChooseCompany = canActAcrossStores\('pdv_requests:create'\);/);
  assert.match(html, /companyId: canActAcrossStores\('pdv_requests:create'\) \? el\('pdvCompany'\)\.value : ''/);
  assert.match(html, /pdvSeesAllStores\(\) \? '<span class="output-company-badge">'/);
});

// ---------------------------------------------------------------------------
// Relatório 41 (Worker): login da loja A não abre report41:store:<B>.
// ---------------------------------------------------------------------------
function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signSession(secret, sub, ver) {
  const payload = toBase64Url(Buffer.from(JSON.stringify({ sub, ver, exp: Date.now() + 3_600_000 }), "utf8"));
  const key = await crypto.subtle.importKey("raw", Buffer.from(secret, "utf8"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, Buffer.from(payload, "utf8"));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

function workerUserD1(user) {
  return {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { statement.args = args; return statement; },
        async first() {
          if (sql.includes("FROM app_users WHERE id =")) return statement.args[0] === user.id ? user : null;
          return null;
        },
        async all() {
          if (sql.includes("PRAGMA table_info")) {
            return { results: ["company_id", "hierarchy", "sector"].map((name) => ({ name })) };
          }
          return { results: [] };
        },
        async run() { return {}; },
      };
      return statement;
    },
    async batch(statements) { return statements.map(() => ({})); },
  };
}

test("Relatório 41: login da loja A recebe 403 em report41:store:<B> (Worker)", async () => {
  const secret = "segredo-de-teste-com-mais-de-32-caracteres";
  const env = {
    APP_LOGIN_USER: "unigames",
    APP_LOGIN_PASSWORD: "senha-de-teste-forte",
    APP_SESSION_SECRET: secret,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const runtime = (await import(workerUrl.href)).default;
  const storeUser = (sector) => ({
    id: `loja-a-${sector || "sem-setor"}`, username: "riomar", displayName: "LOJA RIOMAR", email: "",
    passwordHash: "x", passwordSalt: "x", role: "user", accessGroup: "custom",
    permissionsJson: JSON.stringify(["report41:view"]), companyId: STORE_A, hierarchy: "administrative",
    sector, active: 1, sessionVersion: 1, createdAt: "", updatedAt: "",
  });
  for (const user of [storeUser(""), storeUser("administrative")]) {
    const cookie = `unigames_session=${await signSession(secret, user.id, 1)}`;
    const response = await runtime.fetch(
      new Request(`http://localhost/api/shared-state?key=report41:store:${STORE_B}`, { headers: { accept: "application/json", cookie } }),
      { ...env, DB: workerUserD1(user) },
      ctx,
    );
    assert.equal(response.status, 403, `${user.id} não pode abrir o relatório da loja B`);
  }
});
