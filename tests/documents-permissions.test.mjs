import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Carrega a rota real de /api/documents trocando só o que depende do
// Cloudflare: o binding UPLOADS (R2) e o getD1() viram fakes em memória
// (Map + SQLite), expostos via globalThis.__documentsTestEnv.
const hooks = `
const STUBS = {
  "cloudflare:workers":
    "export const env = new Proxy({}, { get: (_t, key) => globalThis.__documentsTestEnv[key] });",
  db: "export async function getD1() { return globalThis.__documentsTestEnv.DB; }",
};
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: "data:text/javascript," + encodeURIComponent(STUBS["cloudflare:workers"]), shortCircuit: true };
  }
  if (specifier === "../../../db" && context.parentURL && context.parentURL.includes("/app/api/documents/")) {
    return { url: "data:text/javascript," + encodeURIComponent(STUBS.db), shortCircuit: true };
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

function createFakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE documents (
    id text PRIMARY KEY NOT NULL,
    file_name text NOT NULL,
    category text NOT NULL,
    folder text NOT NULL,
    subfolder text DEFAULT '' NOT NULL,
    r2_key text NOT NULL UNIQUE,
    content_type text DEFAULT 'application/pdf' NOT NULL,
    size_bytes integer DEFAULT 0 NOT NULL,
    uploaded_by text NOT NULL,
    uploaded_by_name text DEFAULT '' NOT NULL,
    created_at text NOT NULL
  )`);
  return {
    sqlite,
    prepare(text) {
      // node:sqlite antigo (ex.: Node 22.13 do CI) não liga parâmetros
      // posicionais a placeholders "?1": converte para "?" na ordem de uso.
      const order = [];
      const sql = text.replace(/\?(\d+)/g, (_match, index) => {
        order.push(Number(index) - 1);
        return "?";
      });
      let params = [];
      const statement = {
        bind(...values) {
          params = order.length ? order.map((index) => values[index]) : values;
          return statement;
        },
        async run() {
          sqlite.prepare(sql).run(...params);
          return { success: true };
        },
        async first() {
          return sqlite.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...params) };
        },
      };
      return statement;
    },
  };
}

function createFakeR2() {
  const objects = new Map();
  const toBytes = (value) =>
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return {
    objects,
    async put(key, value) {
      objects.set(key, toBytes(value));
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        async text() {
          return new TextDecoder().decode(bytes);
        },
        async arrayBuffer() {
          return bytes.slice().buffer;
        },
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

const env = { DB: createFakeD1(), UPLOADS: createFakeR2() };
globalThis.__documentsTestEnv = env;

const route = await import("../app/api/documents/route.ts");
const { documentsApiAllowed } = await import("../app/lib/documents-access.ts");

const BASE = "http://127.0.0.1/api/documents";

function headersFor(user, extra = {}) {
  return {
    "x-unigames-user-id": user.id || "user-1",
    "x-unigames-username": "teste",
    "x-unigames-display-name": "TESTE",
    "x-unigames-role": user.role || "user",
    "x-unigames-permissions": (user.permissions || []).join(","),
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function jsonRequest(user, method, url, body) {
  return new Request(url, {
    method,
    headers: headersFor(user, { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Envio em partes completo (create → pedaço → complete), como no front.
async function upload(user, { fileName, content, folder = "garantia-produto", replaceId }) {
  const bytes = new TextEncoder().encode(content);
  const create = await route.POST(
    jsonRequest(user, "POST", BASE, {
      action: "create",
      fileName,
      contentType: "application/pdf",
      fileSize: bytes.byteLength,
      numberOfParts: 1,
      folder,
      replaceId,
    }),
  );
  if (create.status !== 201) return { step: "create", response: create };
  const sessionId = (await create.json()).session.id;
  const chunk = await route.POST(
    new Request(BASE, {
      method: "POST",
      headers: headersFor(user, {
        "content-type": "application/octet-stream",
        "x-document-upload-id": sessionId,
        "x-document-part-number": "1",
      }),
      body: bytes,
    }),
  );
  if (chunk.status !== 200) return { step: "chunk", response: chunk, sessionId };
  const complete = await route.POST(
    jsonRequest(user, "POST", BASE, { action: "complete", sessionId }),
  );
  return { step: "complete", response: complete, sessionId };
}

function documentRow(id) {
  return env.DB.sqlite
    .prepare("SELECT id, file_name AS fileName, folder, subfolder, category, r2_key AS r2Key, size_bytes AS sizeBytes FROM documents WHERE id=?")
    .get(id);
}

const ADMIN = { id: "admin", role: "admin", permissions: [] };
const NO_PERMISSION = { id: "u-none", permissions: ["tasks:view"] };
const CREATOR = { id: "u-create", permissions: ["documents:create"] };
const EDITOR = { id: "u-edit", permissions: ["documents:edit"] };
const DELETER = { id: "u-delete", permissions: ["documents:delete"] };
const COMMERCIAL_ONLY = { id: "u-com", permissions: ["comercial:view", "comercial:manage"] };

async function seedDocument(name = "seed.pdf") {
  const result = await upload(ADMIN, { fileName: name, content: "conteudo original" });
  assert.equal(result.response.status, 201);
  return (await result.response.json()).document.id;
}

test("usuário sem permissão de documentos: 403 em POST/PATCH/DELETE e 200 no GET", async () => {
  const id = await seedDocument();
  assert.equal(documentsApiAllowed(NO_PERMISSION, "GET"), true);
  assert.equal(documentsApiAllowed(NO_PERMISSION, "POST"), false);

  const list = await route.GET(new Request(`${BASE}?folder=garantia-produto`, { headers: headersFor(NO_PERMISSION) }));
  assert.equal(list.status, 200);
  assert.ok((await list.json()).documents.some((doc) => doc.id === id));

  const created = await upload(NO_PERMISSION, { fileName: "novo.pdf", content: "x" });
  assert.equal(created.step, "create");
  assert.equal(created.response.status, 403);
  assert.equal((await created.response.json()).error, "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DOCUMENTOS.");

  const patched = await route.PATCH(jsonRequest(NO_PERMISSION, "PATCH", `${BASE}?id=${id}`, { fileName: "x" }));
  assert.equal(patched.status, 403);
  assert.equal((await patched.json()).error, "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR DOCUMENTOS.");

  const deleted = await route.DELETE(jsonRequest(NO_PERMISSION, "DELETE", `${BASE}?id=${id}`));
  assert.equal(deleted.status, 403);
  assert.equal((await deleted.json()).error, "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR DOCUMENTOS.");
  assert.ok(documentRow(id));
});

test("só documents:create: envia arquivo, mas 403 em PATCH, DELETE e substituição", async () => {
  assert.equal(documentsApiAllowed(CREATOR, "POST"), true);
  const created = await upload(CREATOR, { fileName: "nota.pdf", content: "abc", folder: "documentos-avulsos" });
  assert.equal(created.response.status, 201);
  const id = (await created.response.json()).document.id;
  assert.equal(documentRow(id).folder, "documentos_avulsos");

  const patched = await route.PATCH(jsonRequest(CREATOR, "PATCH", `${BASE}?id=${id}`, { fileName: "outro" }));
  assert.equal(patched.status, 403);
  const deleted = await route.DELETE(jsonRequest(CREATOR, "DELETE", `${BASE}?id=${id}`));
  assert.equal(deleted.status, 403);

  const replaced = await upload(CREATOR, { fileName: "v2.pdf", content: "novo", replaceId: id });
  assert.equal(replaced.step, "create");
  assert.equal(replaced.response.status, 403);
  assert.equal((await replaced.response.json()).error, "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR DOCUMENTOS.");
  assert.equal(documentRow(id).fileName, "nota.pdf");
});

test("só documents:edit: renomeia, move e substitui (apagando o objeto antigo), mas 403 em upload novo/DELETE", async () => {
  const id = await seedDocument("garantia cliente.pdf");
  const before = documentRow(id);

  const renamed = await route.PATCH(jsonRequest(EDITOR, "PATCH", `${BASE}?id=${id}`, { fileName: "  Garantia João  " }));
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).document.fileName, "Garantia João.pdf");
  // Digitar a extensão junto não duplica.
  const renamedAgain = await route.PATCH(jsonRequest(EDITOR, "PATCH", `${BASE}?id=${id}`, { fileName: "Garantia João.PDF" }));
  assert.equal((await renamedAgain.json()).document.fileName, "Garantia João.pdf");
  for (const invalid of ["", "a/b", "a\\b", "x".repeat(200)]) {
    const response = await route.PATCH(jsonRequest(EDITOR, "PATCH", `${BASE}?id=${id}`, { fileName: invalid }));
    assert.equal(response.status, 400, `nome inválido aceito: ${JSON.stringify(invalid)}`);
  }

  const moved = await route.PATCH(jsonRequest(EDITOR, "PATCH", `${BASE}?id=${id}`, { folder: "garantia-estendida" }));
  assert.equal(moved.status, 200);
  const movedBody = await moved.json();
  assert.equal(movedBody.document.folderId, "garantia-estendida");
  const row = documentRow(id);
  assert.equal(row.folder, "certificados");
  assert.equal(row.subfolder, "garantia_estendida");
  assert.equal(row.r2Key, before.r2Key, "mover não mexe no objeto do R2");
  const badFolder = await route.PATCH(jsonRequest(EDITOR, "PATCH", `${BASE}?id=${id}`, { folder: "x" }));
  assert.equal(badFolder.status, 400);
  const missing = await route.PATCH(
    jsonRequest(EDITOR, "PATCH", `${BASE}?id=00000000-0000-0000-0000-000000000000`, { fileName: "x" }),
  );
  assert.equal(missing.status, 404);

  const replaced = await upload(EDITOR, { fileName: "nova versao.docx", content: "conteudo novo!", replaceId: id });
  assert.equal(replaced.response.status, 200);
  const after = documentRow(id);
  assert.equal(after.fileName, "nova versao.docx");
  assert.equal(after.sizeBytes, "conteudo novo!".length);
  assert.equal(after.folder, "certificados", "substituir mantém a pasta atual");
  assert.equal(after.subfolder, "garantia_estendida");
  assert.notEqual(after.r2Key, before.r2Key);
  assert.equal(env.UPLOADS.objects.has(before.r2Key), false, "objeto antigo apagado");
  assert.equal(new TextDecoder().decode(env.UPLOADS.objects.get(after.r2Key)), "conteudo novo!");
  assert.equal(
    [...env.UPLOADS.objects.keys()].some((key) => key.startsWith(`documents/_pending/${replaced.sessionId}`)),
    false,
  );

  const created = await upload(EDITOR, { fileName: "novo.pdf", content: "x" });
  assert.equal(created.step, "create");
  assert.equal(created.response.status, 403);
  const deleted = await route.DELETE(jsonRequest(EDITOR, "DELETE", `${BASE}?id=${id}`));
  assert.equal(deleted.status, 403);
});

test("os pedaços e o complete conferem a permissão da sessão de envio", async () => {
  const bytes = new TextEncoder().encode("abc");
  const create = await route.POST(
    jsonRequest(CREATOR, "POST", BASE, {
      action: "create",
      fileName: "a.pdf",
      contentType: "application/pdf",
      fileSize: bytes.byteLength,
      numberOfParts: 1,
      folder: "garantia-produto",
    }),
  );
  const sessionId = (await create.json()).session.id;
  // Quem só edita não pode alimentar nem concluir um upload NOVO.
  const chunk = await route.POST(
    new Request(BASE, {
      method: "POST",
      headers: headersFor(EDITOR, {
        "content-type": "application/octet-stream",
        "x-document-upload-id": sessionId,
        "x-document-part-number": "1",
      }),
      body: bytes,
    }),
  );
  assert.equal(chunk.status, 403);
  const complete = await route.POST(jsonRequest(EDITOR, "POST", BASE, { action: "complete", sessionId }));
  assert.equal(complete.status, 403);
  const cancel = await route.POST(jsonRequest(CREATOR, "POST", BASE, { action: "cancel", sessionId }));
  assert.equal(cancel.status, 204);
});

test("só documents:delete: exclui", async () => {
  const id = await seedDocument("apagar.pdf");
  const key = documentRow(id).r2Key;
  assert.equal(documentsApiAllowed(DELETER, "DELETE"), true);
  const created = await upload(DELETER, { fileName: "novo.pdf", content: "x" });
  assert.equal(created.response.status, 403);
  const patched = await route.PATCH(jsonRequest(DELETER, "PATCH", `${BASE}?id=${id}`, { fileName: "y" }));
  assert.equal(patched.status, 403);
  const deleted = await route.DELETE(jsonRequest(DELETER, "DELETE", `${BASE}?id=${id}`));
  assert.equal(deleted.status, 204);
  assert.equal(documentRow(id), undefined);
  assert.equal(env.UPLOADS.objects.has(key), false);
});

test("login só-Comercial: bloqueado em tudo, inclusive visualizar", () => {
  for (const method of ["GET", "HEAD", "POST", "PATCH", "DELETE"]) {
    assert.equal(documentsApiAllowed(COMMERCIAL_ONLY, method), false, method);
  }
  // Ganhar uma permissão de documentos deixa de ser só-Comercial.
  const withDocs = { permissions: [...COMMERCIAL_ONLY.permissions, "documents:create"], role: "user" };
  assert.equal(documentsApiAllowed(withDocs, "GET"), true);
  assert.equal(documentsApiAllowed(withDocs, "POST"), true);
  assert.equal(documentsApiAllowed({ role: "admin", permissions: [] }, "DELETE"), true);
});
