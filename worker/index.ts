/** Cloudflare Worker entry point for Estoque Unigames. */
import {
  handleImageOptimization,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  UPLOADS: R2Bucket;
  APP_LOGIN_USER?: string;
  APP_LOGIN_PASSWORD?: string;
  APP_SESSION_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type LoginConfig = {
  username: string;
  password: string;
  sessionSecret: string;
};

type Permission = "tasks" | "purchases" | "stock" | "database" | "pulls";
type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  permissions: Permission[];
  sessionVersion: number;
};
type StoredUserRow = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  role: string;
  permissionsJson: string;
  active: number;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
};

const SESSION_COOKIE = "unigames_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PASSWORD_HASH_ITERATIONS = 100_000;
const LOGIN_SUCCESS_PATH = "/inicio";
const INTERNAL_AUTH_HEADER = "x-unigames-authenticated";
const USER_ID_HEADER = "x-unigames-user-id";
const USERNAME_HEADER = "x-unigames-username";
const DISPLAY_NAME_HEADER = "x-unigames-display-name";
const ROLE_HEADER = "x-unigames-role";
const PERMISSIONS_HEADER = "x-unigames-permissions";
const ALL_PERMISSIONS: Permission[] = ["tasks", "purchases", "stock", "database", "pulls"];
const PUBLIC_ASSET_PATHS = new Set(["/favicon.svg", "/og.png"]);
const APP_ROUTE_PATHS = new Set([
  "/inicio",
  "/puxadas",
  "/compras",
  "/estoque",
  "/tarefas",
  "/cadastros",
  "/cadastros/lojas",
  "/cadastros/base-de-dados",
  "/cadastros/usuarios",
  "/administracao/usuarios",
  "/estoque.html",
]);
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let appUsersReady: Promise<void> | null = null;

function loginConfig(env: Env): LoginConfig | null {
  const username = env.APP_LOGIN_USER?.trim() ?? "";
  const password = env.APP_LOGIN_PASSWORD ?? "";
  const sessionSecret = env.APP_SESSION_SECRET ?? "";
  if (!username || !password || sessionSecret.length < 32) return null;
  return { username, password, sessionSecret };
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://app.local");
    if (parsed.origin !== "https://app.local") return "/";
    if (parsed.pathname === "/login" || parsed.pathname === "/logout") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] ?? character,
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
}

function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return ALL_PERMISSIONS.filter((permission) => value.includes(permission));
}

function permissionsFromJson(value: string): Permission[] {
  try {
    return normalizePermissions(JSON.parse(value));
  } catch {
    return [];
  }
}

function storedUser(row: StoredUserRow): AuthenticatedUser {
  const role = row.role === "admin" ? "admin" : "user";
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role,
    permissions: role === "admin" ? [...ALL_PERMISSIONS] : permissionsFromJson(row.permissionsJson),
    sessionVersion: row.sessionVersion,
  };
}

function envAdministrator(config: LoginConfig): AuthenticatedUser {
  return {
    id: "env-admin",
    username: config.username,
    displayName: "Administrador principal",
    role: "admin",
    permissions: [...ALL_PERMISSIONS],
    sessionVersion: 1,
  };
}

async function ensureAppUsersTable(database: D1Database): Promise<void> {
  if (!appUsersReady) {
    appUsersReady = database.batch([
      database.prepare(
        `CREATE TABLE IF NOT EXISTS app_users (
          id TEXT PRIMARY KEY NOT NULL,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          permissions_json TEXT NOT NULL DEFAULT '[]',
          active INTEGER NOT NULL DEFAULT 1,
          session_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      ),
      database.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS app_users_username_unique ON app_users (username)",
      ),
    ]).then(() => undefined).catch((error) => {
      appUsersReady = null;
      throw error;
    });
  }
  return appUsersReady;
}

async function readUserByUsername(database: D1Database, username: string) {
  await ensureAppUsersTable(database);
  return database
    .prepare(
      `SELECT id, username, display_name AS displayName, password_hash AS passwordHash,
              password_salt AS passwordSalt, role, permissions_json AS permissionsJson,
              active, session_version AS sessionVersion, created_at AS createdAt,
              updated_at AS updatedAt
       FROM app_users WHERE lower(username) = lower(?1) LIMIT 1`,
    )
    .bind(username)
    .first<StoredUserRow>();
}

async function readUserById(database: D1Database, id: string) {
  await ensureAppUsersTable(database);
  return database
    .prepare(
      `SELECT id, username, display_name AS displayName, password_hash AS passwordHash,
              password_salt AS passwordSalt, role, permissions_json AS permissionsJson,
              active, session_version AS sessionVersion, created_at AS createdAt,
              updated_at AS updatedAt
       FROM app_users WHERE id = ?1 LIMIT 1`,
    )
    .bind(id)
    .first<StoredUserRow>();
}

async function passwordDigest(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_HASH_ITERATIONS },
    key,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await passwordDigest(password, salt), salt: toBase64Url(salt) };
}

async function verifyPassword(password: string, row: StoredUserRow): Promise<boolean> {
  const digest = await passwordDigest(password, fromBase64Url(row.passwordSalt));
  return constantTimeEqual(digest, row.passwordHash);
}

async function createSession(user: AuthenticatedUser, secret: string): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        sub: user.id,
        ver: user.sessionVersion,
        exp: Date.now() + SESSION_TTL_SECONDS * 1000,
      }),
    ),
  );
  return `${payload}.${await hmac(payload, secret)}`;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const item of cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return null;
}

async function authenticatedUser(
  request: Request,
  env: Env,
  config: LoginConfig,
): Promise<AuthenticatedUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;

  try {
    const expected = await hmac(payload, config.sessionSecret);
    if (!constantTimeEqual(signature, expected)) return null;
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as {
      sub?: unknown;
      ver?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.sub !== "string" ||
      typeof parsed.ver !== "number" ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= Date.now()
    ) return null;
    if (parsed.sub === "env-admin" && parsed.ver === 1) return envAdministrator(config);
    if (!env.DB) return null;
    const row = await readUserById(env.DB, parsed.sub);
    if (!row || row.active !== 1 || row.sessionVersion !== parsed.ver) return null;
    return storedUser(row);
  } catch {
    return null;
  }
}

function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function isRateLimited(request: Request): boolean {
  const key = clientKey(request);
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (attempt.resetAt <= Date.now()) {
    loginAttempts.delete(key);
    return false;
  }
  return attempt.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailure(request: Request): void {
  const key = clientKey(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function clearFailures(request: Request): void {
  loginAttempts.delete(clientKey(request));
}

function loginPage(options: {
  next: string;
  status?: number;
  message?: string;
  configured: boolean;
}): Response {
  const { next, status = 200, message = "", configured } = options;
  const notice = message
    ? `<div class="notice" role="alert">${escapeHtml(message)}</div>`
    : "";
  const disabled = configured ? "" : " disabled";
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Entrar · Estoque Unigames</title>
  <style>
    :root{color-scheme:dark;--bg:#06111d;--panel:#0b1b2c;--line:#2b5f8f;--accent:#65b8ff;--ink:#f5f9ff;--soft:#a9bfd3;}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 10%,#173754 0,transparent 36%),radial-gradient(circle at 90% 90%,#102945 0,transparent 34%),var(--bg);font-family:Arial,Helvetica,sans-serif;color:var(--ink)}
    main{width:min(430px,100%);background:linear-gradient(180deg,rgba(17,42,66,.98),rgba(7,24,40,.98));border:1px solid rgba(101,184,255,.38);border-radius:20px;padding:34px;box-shadow:0 28px 80px rgba(0,0,0,.48),inset 0 1px rgba(255,255,255,.05)}
    .brand{display:flex;align-items:center;gap:14px;margin-bottom:28px}.mark{display:grid;place-items:center;width:48px;height:48px;border:1px solid var(--accent);border-radius:14px;color:var(--accent);font-weight:900;box-shadow:0 0 24px rgba(101,184,255,.18)}
    h1{font-size:24px;margin:0 0 5px}.brand p,.intro{margin:0;color:var(--soft)}.intro{font-size:14px;line-height:1.55;margin-bottom:24px}
    label{display:block;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin:16px 0 8px;color:#dcecff}input{width:100%;border:1px solid rgba(101,184,255,.35);border-radius:11px;background:#071522;color:var(--ink);padding:13px 14px;font:inherit;outline:none}input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(101,184,255,.13)}
    button{width:100%;margin-top:22px;border:0;border-radius:11px;padding:14px;background:linear-gradient(135deg,#4f9fe5,#76c4ff);color:#04111d;font-weight:900;font-size:14px;cursor:pointer}button:hover{filter:brightness(1.06)}button:disabled{opacity:.45;cursor:not-allowed}.notice{border:1px solid rgba(255,112,112,.45);background:rgba(126,28,28,.24);color:#ffd6d6;border-radius:10px;padding:11px 12px;font-size:13px;margin-bottom:18px}.security{margin:22px 0 0;color:#7894aa;text-align:center;font-size:11px;line-height:1.5}
    @media(max-width:480px){main{padding:27px 21px;border-radius:16px}}
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">EU</div><div><h1>Estoque Unigames</h1><p>Acesso restrito</p></div></div>
    <p class="intro">Entre com as credenciais fornecidas pela administração para acessar o controle de estoque e compras.</p>
    ${notice}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <label for="username">Usuário</label>
      <input id="username" name="username" type="text" autocomplete="username" required${disabled}>
      <label for="password">Senha</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required${disabled}>
      <button type="submit"${disabled}>Entrar no sistema</button>
    </form>
    <p class="security">Sessão protegida e válida por 12 horas. Não compartilhe a senha em canais públicos.</p>
  </main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const config = loginConfig(env);
  const next = LOGIN_SUCCESS_PATH;
  if (!config) {
    return loginPage({
      next,
      status: 503,
      message: "O acesso ainda não foi configurado pela administração.",
      configured: false,
    });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (await authenticatedUser(request, env, config)) {
      return Response.redirect(new URL(next, url.origin), 303);
    }
    return loginPage({ next, configured: true });
  }

  if (request.method !== "POST") {
    return new Response("Método não permitido", {
      status: 405,
      headers: { allow: "GET, HEAD, POST" },
    });
  }

  if (isRateLimited(request)) {
    return loginPage({
      next,
      status: 429,
      message: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
      configured: true,
    });
  }

  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  let user: AuthenticatedUser | null = null;
  if (
    constantTimeEqual(username, config.username) &&
    constantTimeEqual(password, config.password)
  ) {
    user = envAdministrator(config);
  } else if (env.DB) {
    try {
      const row = await readUserByUsername(env.DB, username);
      if (row && row.active === 1 && await verifyPassword(password, row)) {
        user = storedUser(row);
      }
    } catch {
      user = null;
    }
  }
  if (!user) {
    recordFailure(request);
    return loginPage({
      next,
      status: 401,
      message: "Usuário ou senha inválidos.",
      configured: true,
    });
  }

  clearFailures(request);
  const token = await createSession(user, config.sessionSecret);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: LOGIN_SUCCESS_PATH,
      "cache-control": "no-store",
      "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
    },
  });
}

function handleLogout(request: Request, url: URL): Response {
  if (request.method !== "POST") {
    return new Response("Método não permitido", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: "/login",
      "cache-control": "no-store",
      "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`,
    },
  });
}

function unauthorized(request: Request, url: URL): Response {
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "SESSÃO EXPIRADA OU NÃO AUTORIZADA." }, { status: 401 });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const next = safeNext(`${url.pathname}${url.search}`);
    return Response.redirect(
      new URL(`/login?next=${encodeURIComponent(next)}`, url.origin),
      303,
    );
  }
  return Response.json({ error: "SESSÃO EXPIRADA OU NÃO AUTORIZADA." }, { status: 401 });
}

function forbidden(request: Request, url: URL): Response {
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR ESTE MÓDULO." }, { status: 403 });
  }
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Acesso não permitido</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#06111d;color:#f5f9ff;font-family:Arial,sans-serif;padding:24px}.card{max-width:520px;padding:32px;border:1px solid #2b5f8f;border-radius:18px;background:#0b1b2c;text-align:center}h1{font-size:24px}p{color:#a9bfd3;line-height:1.55}a{display:inline-block;margin-top:12px;padding:12px 18px;border-radius:10px;background:#65b8ff;color:#04111d;font-weight:800;text-decoration:none}</style></head><body><main class="card"><h1>Acesso não permitido</h1><p>Seu usuário não possui autorização para abrir este módulo. Se precisar dele, solicite a liberação ao administrador.</p><a href="/inicio">Voltar ao início</a></main></body></html>`;
  return new Response(html, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function hasPermission(user: AuthenticatedUser, permission: Permission): boolean {
  return user.role === "admin" || user.permissions.includes(permission);
}

function hasAnyPermission(user: AuthenticatedUser, permissions: Permission[]): boolean {
  return user.role === "admin" || permissions.some((permission) => user.permissions.includes(permission));
}

function sharedStatePermission(key: string, scope: string): Permission | Permission[] {
  const normalized = `${scope}:${key}`.toLowerCase();
  if (normalized.includes("tarefa")) return "tasks";
  if (normalized.includes("puxada")) return "pulls";
  return ["stock", "database", "pulls"];
}

async function isAllowed(request: Request, url: URL, user: AuthenticatedUser): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/cadastros/usuarios" || path === "/administracao/usuarios" || path === "/api/admin/users") {
    return user.role === "admin";
  }
  const directPermissions: Array<[boolean, Permission]> = [
    [path === "/tarefas", "tasks"],
    [path === "/compras" || path.startsWith("/api/compras"), "purchases"],
    [path === "/estoque", "stock"],
    [path === "/puxadas", "pulls"],
    [path === "/cadastros" || path.startsWith("/cadastros/"), "database"],
  ];
  const direct = directPermissions.find(([matches]) => matches);
  if (direct) return hasPermission(user, direct[1]);
  if (path === "/api/shared-state") {
    let key = url.searchParams.get("key") ?? "";
    let scope = url.searchParams.get("scope") ?? "";
    if (request.method === "PUT" || request.method === "POST") {
      try {
        const body = await request.clone().json() as { key?: unknown; scope?: unknown };
        if (typeof body.key === "string") key = body.key;
        if (typeof body.scope === "string") scope = body.scope;
      } catch {
        return false;
      }
    }
    const required = sharedStatePermission(key, scope);
    return Array.isArray(required) ? hasAnyPermission(user, required) : hasPermission(user, required);
  }
  return true;
}

function sessionResponse(user: AuthenticatedUser): Response {
  return Response.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: user.permissions,
  }, { headers: { "cache-control": "no-store" } });
}

function validUsername(value: string): boolean {
  return /^[a-z0-9._-]{3,40}$/i.test(value);
}

function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}

function publicUser(row: StoredUserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role === "admin" ? "admin" : "user",
    permissions: permissionsFromJson(row.permissionsJson),
    active: row.active === 1,
    managed: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listUsers(env: Env, config: LoginConfig): Promise<Response> {
  await ensureAppUsersTable(env.DB);
  const result = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, password_hash AS passwordHash,
            password_salt AS passwordSalt, role, permissions_json AS permissionsJson,
            active, session_version AS sessionVersion, created_at AS createdAt,
            updated_at AS updatedAt
     FROM app_users ORDER BY display_name COLLATE NOCASE`,
  ).all<StoredUserRow>();
  return Response.json({
    users: [{
      id: "env-admin",
      username: config.username,
      displayName: "Administrador principal",
      role: "admin",
      permissions: ALL_PERMISSIONS,
      active: true,
      managed: false,
    }, ...(result.results ?? []).map(publicUser)],
  });
}

async function handleAdminUsers(
  request: Request,
  env: Env,
  url: URL,
  config: LoginConfig,
): Promise<Response> {
  try {
    await ensureAppUsersTable(env.DB);
  } catch (error) {
    console.error("Não foi possível preparar a tabela de usuários.", error);
    return jsonError("NÃO FOI POSSÍVEL PREPARAR O CADASTRO DE USUÁRIOS.", 500);
  }
  if (request.method === "GET") return listUsers(env, config);
  if (!sameOrigin(request, url)) return jsonError("ORIGEM DA SOLICITAÇÃO NÃO PERMITIDA.", 403);
  if (request.method !== "POST" && request.method !== "PATCH") {
    return new Response("Método não permitido", { status: 405, headers: { allow: "GET, POST, PATCH" } });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError("DADOS INVÁLIDOS.", 400);
  }

  const username = String(body.username ?? "").trim().toLowerCase();
  const displayName = String(body.displayName ?? "").trim();
  const password = String(body.password ?? "");
  const permissions = normalizePermissions(body.permissions);
  if (!validUsername(username)) {
    return jsonError("O USUÁRIO DEVE TER DE 3 A 40 CARACTERES: LETRAS, NÚMEROS, PONTO, HÍFEN OU _.", 400);
  }
  if (displayName.length < 2 || displayName.length > 80) {
    return jsonError("INFORME UM NOME ENTRE 2 E 80 CARACTERES.", 400);
  }

  try {
    if (request.method === "POST") {
      if (password.length < 8 || password.length > 200) {
        return jsonError("A SENHA DEVE TER PELO MENOS 8 CARACTERES.", 400);
      }
      const credential = await hashPassword(password);
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO app_users
          (id, username, display_name, password_hash, password_salt, role, permissions_json, active, session_version)
         VALUES (?1, ?2, ?3, ?4, ?5, 'user', ?6, 1, 1)`,
      ).bind(id, username, displayName, credential.hash, credential.salt, JSON.stringify(permissions)).run();
      const created = await readUserById(env.DB, id);
      return Response.json({ user: created ? publicUser(created) : null }, { status: 201 });
    }

    const id = String(body.id ?? "");
    if (!id || id === "env-admin") return jsonError("O ADMINISTRADOR PRINCIPAL NÃO PODE SER ALTERADO AQUI.", 400);
    const existing = await readUserById(env.DB, id);
    if (!existing) return jsonError("USUÁRIO NÃO ENCONTRADO.", 404);
    const active = body.active === false ? 0 : 1;
    if (password && (password.length < 8 || password.length > 200)) {
      return jsonError("A NOVA SENHA DEVE TER PELO MENOS 8 CARACTERES.", 400);
    }
    if (password) {
      const credential = await hashPassword(password);
      await env.DB.prepare(
        `UPDATE app_users SET username=?1, display_name=?2, permissions_json=?3, active=?4,
          password_hash=?5, password_salt=?6, session_version=session_version+1,
          updated_at=CURRENT_TIMESTAMP WHERE id=?7`,
      ).bind(username, displayName, JSON.stringify(permissions), active, credential.hash, credential.salt, id).run();
    } else {
      await env.DB.prepare(
        `UPDATE app_users SET username=?1, display_name=?2, permissions_json=?3, active=?4,
          session_version=session_version+1, updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
      ).bind(username, displayName, JSON.stringify(permissions), active, id).run();
    }
    const updated = await readUserById(env.DB, id);
    return Response.json({ user: updated ? publicUser(updated) : null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error("Não foi possível salvar o usuário.", error);
    if (/unique|constraint/i.test(message)) return jsonError("ESTE NOME DE USUÁRIO JÁ ESTÁ EM USO.", 409);
    return jsonError("NÃO FOI POSSÍVEL SALVAR O USUÁRIO.", 500);
  }
}

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", "noindex, nofollow");
  if ((headers.get("content-type") ?? "").includes("text/html")) {
    headers.set("cache-control", "private, no-store");
    headers.append("vary", "Cookie");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/login") return handleLogin(request, env, url);
    if (url.pathname === "/logout") return handleLogout(request, url);
    if (PUBLIC_ASSET_PATHS.has(url.pathname)) return env.ASSETS.fetch(request);

    const config = loginConfig(env);
    if (!config) return unauthorized(request, url);
    const user = await authenticatedUser(request, env, config);
    if (!user) return unauthorized(request, url);
    if (!(await isAllowed(request, url, user))) return forbidden(request, url);
    if (url.pathname === "/api/session") return sessionResponse(user);
    if (url.pathname === "/api/admin/users") {
      return securityHeaders(await handleAdminUsers(request, env, url, config));
    }

    const authenticatedHeaders = new Headers(request.headers);
    authenticatedHeaders.delete(USER_ID_HEADER);
    authenticatedHeaders.delete(USERNAME_HEADER);
    authenticatedHeaders.delete(DISPLAY_NAME_HEADER);
    authenticatedHeaders.delete(ROLE_HEADER);
    authenticatedHeaders.delete(PERMISSIONS_HEADER);
    authenticatedHeaders.set(INTERNAL_AUTH_HEADER, "1");
    authenticatedHeaders.set(USER_ID_HEADER, user.id);
    authenticatedHeaders.set(USERNAME_HEADER, user.username);
    authenticatedHeaders.set(DISPLAY_NAME_HEADER, encodeURIComponent(user.displayName));
    authenticatedHeaders.set(ROLE_HEADER, user.role);
    authenticatedHeaders.set(PERMISSIONS_HEADER, user.permissions.join(","));
    const authenticatedRequest = new Request(request, {
      headers: authenticatedHeaders,
    });

    const normalizedPath =
      url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      APP_ROUTE_PATHS.has(normalizedPath)
    ) {
      if (normalizedPath !== url.pathname) {
        const canonicalUrl = new URL(normalizedPath, url.origin);
        canonicalUrl.search = url.search;
        return Response.redirect(canonicalUrl, 308);
      }
      const appAssetUrl = new URL("/estoque.html", request.url);
      const appAssetRequest = new Request(appAssetUrl, authenticatedRequest);
      return securityHeaders(await env.ASSETS.fetch(appAssetRequest));
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(
        authenticatedRequest,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
      return securityHeaders(response);
    }

    return securityHeaders(await handler.fetch(authenticatedRequest, env, ctx));
  },
};

export default worker;
