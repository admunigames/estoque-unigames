/** Cloudflare Worker entry point for Estoque Unigames. */
import {
  handleImageOptimization,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import webPush from "web-push";
import {
  liveInvalidationForRequest,
  liveInvalidationForResponse,
} from "./live-events";
import {
  LiveUpdates,
  isLiveModule,
  type LiveInvalidation,
  type LiveModule,
} from "./live-updates";

export { LiveUpdates };

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type LoginConfig = {
  username: string;
  password: string;
  sessionSecret: string;
};

type Permission =
  | "tasks:view" | "tasks:manage"
  | "missions:view" | "missions:create" | "missions:delete" | "missions:notify"
  | "captures:view" | "captures:create" | "captures:receive" | "captures:assign" | "captures:delete"
  | "outputs:view" | "outputs:create" | "outputs:complete" | "outputs:delete"
  | "inputs:view" | "inputs:create" | "inputs:complete" | "inputs:delete"
  | "supplies:view" | "supplies:request" | "supplies:receive" | "supplies:stock_in" | "supplies:stock_out" | "supplies:delete" | "supplies:manage_catalog"
  | "purchases:view" | "purchases:create" | "purchases:edit" | "purchases:delete" | "purchases:send_to_finance"
  | "stock:view"
  | "database:view" | "database:manage"
  | "pulls:view"
  | "report41:view"
  | "documents_manage"
  | "instructions:manage"
  | "pdv_requests:view" | "pdv_requests:create" | "pdv_requests:delete" | "pdv_requests:status"
  | "os_notes:view" | "os_notes:create" | "os_notes:attach" | "os_notes:delete"
  | "finance:manage"
  | "payroll:manage"
  | "payables:invoices_view" | "payables:invoices_reconcile" | "payables:confirm_payment" | "payables:return_to_purchases"
  | "loans:view" | "loans:create" | "loans:edit" | "loans:delete" | "loans:request" | "loans:manage_requests"
  | "users:manage";
type AccessGroup = "administrator" | "purchases" | "fiscal" | "operator" | "assistance" | "custom";
type UserHierarchy = "director" | "supervisor" | "administrative";
type UserSector = "" | "administrative" | "assistance" | "deposit";
type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  companyId: string;
  hierarchy: UserHierarchy;
  sector: UserSector;
  accessGroup: AccessGroup;
  role: "admin" | "user";
  permissions: Permission[];
  sessionVersion: number;
};
type StoredUserRow = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  role: string;
  accessGroup: string;
  permissionsJson: string;
  companyId: string;
  hierarchy: string;
  sector: string;
  active: number;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  recoveryRequested?: number;
};

const SESSION_COOKIE = "unigames_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PASSWORD_HASH_ITERATIONS = 100_000;
const LOGIN_SUCCESS_PATH = "/inicio?entrada=1";
const INTERNAL_AUTH_HEADER = "x-unigames-authenticated";
const USER_ID_HEADER = "x-unigames-user-id";
const USERNAME_HEADER = "x-unigames-username";
const DISPLAY_NAME_HEADER = "x-unigames-display-name";
const ROLE_HEADER = "x-unigames-role";
const ACCESS_GROUP_HEADER = "x-unigames-access-group";
const PERMISSIONS_HEADER = "x-unigames-permissions";
const COMPANY_ID_HEADER = "x-unigames-company-id";
const SECTOR_HEADER = "x-unigames-sector";
const ASSIGNABLE_PERMISSIONS: Permission[] = [
  "tasks:view", "tasks:manage",
  "missions:view", "missions:create", "missions:delete", "missions:notify",
  "captures:view", "captures:create", "captures:receive", "captures:assign", "captures:delete",
  "outputs:view", "outputs:create", "outputs:complete", "outputs:delete",
  "inputs:view", "inputs:create", "inputs:complete", "inputs:delete",
  "supplies:view", "supplies:request", "supplies:receive", "supplies:stock_in", "supplies:stock_out", "supplies:delete", "supplies:manage_catalog",
  "purchases:view", "purchases:create", "purchases:edit", "purchases:delete", "purchases:send_to_finance",
  "stock:view",
  "database:view", "database:manage",
  "pulls:view",
  "report41:view",
  "instructions:manage",
  "pdv_requests:view", "pdv_requests:create", "pdv_requests:delete", "pdv_requests:status",
  "os_notes:view", "os_notes:create", "os_notes:attach", "os_notes:delete",
  "finance:manage",
  // RH Financeiro (Folha, Benefícios, Comissionamento) — permissão única e
  // independente de finance:manage, pra quem cuida do RH acessar só esses
  // três módulos, e quem cuida do Financeiro não ganhar o RH de brinde.
  "payroll:manage",
  "payables:invoices_view", "payables:invoices_reconcile", "payables:confirm_payment", "payables:return_to_purchases",
  "loans:view", "loans:create", "loans:edit", "loans:delete", "loans:request", "loans:manage_requests",
  "users:manage",
];
// documents_manage continua exclusivo de administrador: nunca pode ser
// atribuída a um usuário custom, mesmo pela tela de cadastro.
const ALL_PERMISSIONS: Permission[] = [...ASSIGNABLE_PERMISSIONS, "documents_manage"];
const ACCESS_GROUP_PERMISSIONS: Record<AccessGroup, Permission[]> = {
  administrator: [...ALL_PERMISSIONS],
  purchases: [
    "tasks:view", "tasks:manage",
    "missions:view", "missions:notify",
    "captures:view", "captures:create",
    "outputs:view", "outputs:create",
    "supplies:view", "supplies:request", "supplies:receive", "supplies:stock_out",
    "purchases:view", "purchases:create", "purchases:edit", "purchases:delete",
  ],
  fiscal: [
    "missions:view",
    "outputs:view", "outputs:create",
    "supplies:view", "supplies:request", "supplies:receive", "supplies:stock_out",
    "stock:view",
    "database:view", "database:manage",
    "pulls:view",
    "report41:view",
  ],
  operator: [
    "tasks:view", "tasks:manage",
    "missions:view", "missions:notify",
    "captures:view", "captures:create",
    "outputs:view", "outputs:create",
    "supplies:view", "supplies:request", "supplies:receive", "supplies:stock_out",
    "loans:view", "loans:request",
  ],
  assistance: ["captures:view", "captures:create", "captures:receive", "captures:delete"],
  custom: [],
};
// Mapa de compatibilidade: converte as chaves de permissão do formato antigo
// (um valor por módulo inteiro) para o novo formato módulo:ação, preservando
// só o que aquele valor já liberava de fato hoje (nunca expande privilégio
// que o usuário não tinha antes da migração). Usado ao ler permissionsJson
// de usuários custom já cadastrados.
const LEGACY_PERMISSION_MAP: Record<string, Permission[]> = {
  "tasks": ["tasks:view", "tasks:manage"],
  // "missions" hoje conflava ver + receber lembretes de missão pendente
  // (missionNotificationAllowed usava a mesma flag) — preserva as duas para
  // não tirar notificação de quem já recebia. Criar/excluir sempre foi
  // exclusivo do admin (hardcoded), então não migra para cá.
  "missions": ["missions:view", "missions:notify"],
  "captures": ["captures:view", "captures:create"],
  "outputs": ["outputs:view", "outputs:create"],
  "supplies": ["supplies:view", "supplies:request", "supplies:receive"],
  "supplies_in": ["supplies:stock_in"],
  "supplies_out": ["supplies:stock_out"],
  "supplies_delete": ["supplies:delete"],
  "purchases": ["purchases:view", "purchases:create", "purchases:edit", "purchases:delete"],
  "stock": ["stock:view"],
  "database": ["database:view", "database:manage"],
  "pulls": ["pulls:view"],
  "report41": ["report41:view"],
};
function expandLegacyPermissions(raw: unknown[]): unknown[] {
  const expanded: unknown[] = [];
  for (const value of raw) {
    if (typeof value === "string" && LEGACY_PERMISSION_MAP[value]) {
      expanded.push(...LEGACY_PERMISSION_MAP[value]);
    } else {
      expanded.push(value);
    }
  }
  return expanded;
}
const PUBLIC_ASSET_PATHS = new Set([
  "/favicon.svg",
  "/unigames-logo.png",
  "/manifest.webmanifest",
  "/service-worker.js",
]);
const APP_ROUTE_PATHS = new Set([
  "/inicio",
  "/puxadas",
  "/relatorio-41",
  "/compras",
  "/estoque",
  "/tarefas",
  "/missoes",
  "/captacao",
  "/saidas",
  "/entradas",
  "/insumos",
  "/aparelhos-emprestimo",
  "/instrucoes",
  "/solicitacoes/alteracoes-pdv",
  "/solicitacoes/notas-os",
  "/cadastros",
  "/cadastros/lojas",
  "/cadastros/base-de-dados",
  "/cadastros/usuarios",
  "/rh/folgas",
  "/rh/escalas",
  "/rh/funcionarios",
  "/rh/folha",
  "/rh/beneficios",
  "/rh/comissionamento",
  "/financeiro/painel",
  "/financeiro/dre",
  "/financeiro/contas-a-pagar",
  "/financeiro/notas-fiscais",
  "/financeiro/despesas",
  "/financeiro/fornecedores/conta-corrente",
  "/financeiro/orcamento",
  "/financeiro/recebiveis",
  "/financeiro/fluxo-de-caixa",
  "/financeiro/maquinetas",
  "/financeiro/taxas-cartao",
  "/documentos",
  "/documentos/certificados/garantia-de-produto",
  "/documentos/certificados/garantia-estendida",
  "/documentos/documentos-avulsos",
  "/administracao/usuarios",
  "/estoque.html",
]);
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let appUsersReady: Promise<void> | null = null;
let postgresAppUsersReady: Promise<void> | null = null;
let automaticBackupDate = "";

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

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
  // Aceita tanto o formato antigo (um valor por módulo) quanto o novo
  // (módulo:ação), expandindo chaves antigas para seus equivalentes
  // granulares antes de filtrar. documents_manage continua deliberadamente
  // exclusivo de administrador: uma requisição de cadastro de usuário
  // manipulada não consegue persisti-la para um usuário comum/custom.
  const expanded = expandLegacyPermissions(value);
  return ASSIGNABLE_PERMISSIONS.filter((permission) => expanded.includes(permission));
}

function normalizeAccessGroup(value: unknown): AccessGroup {
  return value === "administrator" ||
    value === "purchases" ||
    value === "fiscal" ||
    value === "operator" ||
    value === "assistance" ||
    value === "custom"
    ? value
    : "custom";
}

function normalizeHierarchy(value: unknown): UserHierarchy {
  return value === "director" || value === "supervisor" ? value : "administrative";
}

function normalizeSector(value: unknown): UserSector {
  return value === "administrative" || value === "assistance" || value === "deposit" ? value : "";
}

function accessForGroup(group: AccessGroup, requested: unknown) {
  if (group === "custom") {
    return { role: "user" as const, permissions: normalizePermissions(requested) };
  }
  if (group === "administrator") {
    return { role: "admin" as const, permissions: [...ALL_PERMISSIONS] };
  }
  return { role: "user" as const, permissions: [...ACCESS_GROUP_PERMISSIONS[group]] };
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
  const accessGroup = role === "admin"
    ? "administrator"
    : normalizeAccessGroup(row.accessGroup);
  const permissions = role === "admin"
    ? [...ALL_PERMISSIONS]
    : accessGroup === "custom"
      ? permissionsFromJson(row.permissionsJson)
      : [...ACCESS_GROUP_PERMISSIONS[accessGroup]];
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    companyId: row.companyId || "",
    hierarchy: normalizeHierarchy(row.hierarchy),
    sector: normalizeSector(row.sector),
    accessGroup,
    role,
    permissions,
    sessionVersion: row.sessionVersion,
  };
}

function envAdministrator(config: LoginConfig): AuthenticatedUser {
  return {
    id: "env-admin",
    username: config.username,
    displayName: "Administrador principal",
    companyId: "",
    hierarchy: "director",
    sector: "",
    accessGroup: "administrator",
    role: "admin",
    permissions: [...ALL_PERMISSIONS],
    sessionVersion: 1,
  };
}

async function ensureAppUsersTable(database: D1Database): Promise<void> {
  if (process.env.DB_DRIVER === "postgres") {
    if (!postgresAppUsersReady) {
      postgresAppUsersReady = database.batch([
        database.prepare(
          "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS hierarchy TEXT NOT NULL DEFAULT 'administrative'",
        ),
        database.prepare(
          "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS sector TEXT NOT NULL DEFAULT ''",
        ),
        database.prepare(
          "UPDATE app_users SET sector='assistance', company_id='' WHERE access_group='assistance' OR lower(username)='assistencia'",
        ),
      ]).then(() => undefined).catch((error) => {
        postgresAppUsersReady = null;
        throw error;
      });
    }
    return postgresAppUsersReady;
  }

  if (!appUsersReady) {
    appUsersReady = (async () => {
      await database.batch([
        database.prepare(
          `CREATE TABLE IF NOT EXISTS app_users (
            id TEXT PRIMARY KEY NOT NULL,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            email TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            access_group TEXT NOT NULL DEFAULT 'operator',
            permissions_json TEXT NOT NULL DEFAULT '[]',
            company_id TEXT NOT NULL DEFAULT '',
            hierarchy TEXT NOT NULL DEFAULT 'administrative',
            sector TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            session_version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
        ),
        database.prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS app_users_username_unique ON app_users (username)",
        ),
      ]);
      const columns = await database
        .prepare("PRAGMA table_info(app_users)")
        .all<{ name: string }>();
      if (!(columns.results ?? []).some((column) => column.name === "company_id")) {
        await database.prepare(
          "ALTER TABLE app_users ADD COLUMN company_id TEXT NOT NULL DEFAULT ''",
        ).run();
      }
      if (!(columns.results ?? []).some((column) => column.name === "hierarchy")) {
        await database.prepare(
          "ALTER TABLE app_users ADD COLUMN hierarchy TEXT NOT NULL DEFAULT 'administrative'",
        ).run();
      }
      if (!(columns.results ?? []).some((column) => column.name === "sector")) {
        await database.prepare(
          "ALTER TABLE app_users ADD COLUMN sector TEXT NOT NULL DEFAULT ''",
        ).run();
        await database.prepare(
          "UPDATE app_users SET sector='assistance', company_id='' WHERE access_group='assistance' OR lower(username)='assistencia'",
        ).run();
      }
    })().catch((error) => {
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
              email, password_salt AS passwordSalt, role, access_group AS accessGroup,
              permissions_json AS permissionsJson, company_id AS companyId, hierarchy, sector,
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
              email, password_salt AS passwordSalt, role, access_group AS accessGroup,
              permissions_json AS permissionsJson, company_id AS companyId, hierarchy, sector,
              active, session_version AS sessionVersion, created_at AS createdAt,
              updated_at AS updatedAt
       FROM app_users WHERE id = ?1 LIMIT 1`,
    )
    .bind(id)
    .first<StoredUserRow>();
}

async function passwordDigest(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<string> {
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

// Erro distinto de "sessao invalida": sinaliza que o token em si e valido mas
// a consulta ao banco falhou (ex.: pool do Postgres/Hyperdrive saturado sob
// uma rajada de requisicoes paralelas logo apos o login). Nao deve ser
// tratado como 401 pelo chamador — isso faria o cliente redirecionar para
// /login mesmo com a sessao valida, e como o GET /login redireciona de volta
// quando ve uma sessao valida, gera um loop de recarregamento ate a rajada
// de requisicoes se resolver sozinha.
class SessionLookupError extends Error {}

async function authenticatedUser(
  request: Request,
  env: Env,
  config: LoginConfig,
): Promise<AuthenticatedUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;

  let parsed: { sub?: unknown; ver?: unknown; exp?: unknown };
  try {
    const expected = await hmac(payload, config.sessionSecret);
    if (!constantTimeEqual(signature, expected)) return null;
    parsed = JSON.parse(decoder.decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (
    typeof parsed.sub !== "string" ||
    typeof parsed.ver !== "number" ||
    typeof parsed.exp !== "number" ||
    parsed.exp <= Date.now()
  ) return null;
  if (parsed.sub === "env-admin" && parsed.ver === 1) return envAdministrator(config);
  if (!env.DB) return null;

  let row: Awaited<ReturnType<typeof readUserById>>;
  try {
    row = await readUserById(env.DB, parsed.sub);
  } catch (error) {
    throw new SessionLookupError(
      error instanceof Error ? error.message : "Falha ao consultar o usuario da sessao",
    );
  }
  if (!row || row.active !== 1 || row.sessionVersion !== parsed.ver) return null;
  return storedUser(row);
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
  <meta name="theme-color" content="#050d18">
  <link rel="icon" type="image/png" href="/icon-32.png">
  <link rel="apple-touch-icon" href="/icon-180.png">
  <title>Entrar · Unigames</title>
  <style>
    :root{color-scheme:dark;--bg:#030914;--panel:#081625;--cyan:#66d9ff;--blue:#4b8dff;--violet:#8b6cff;--mint:#65f7ce;--ink:#f5fbff;--soft:#9eb5c9;--line:rgba(125,210,255,.23)}
    *{box-sizing:border-box}
    html{min-height:100%;background:var(--bg);scrollbar-gutter:stable}
    body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;overflow-x:hidden;padding:30px;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:
      radial-gradient(circle at 8% 12%,rgba(64,122,211,.23),transparent 31%),
      radial-gradient(circle at 92% 82%,rgba(86,67,190,.19),transparent 33%),
      linear-gradient(145deg,#030914 0%,#061321 52%,#020711 100%)}
    body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.36;background-image:
      linear-gradient(rgba(112,205,255,.07) 1px,transparent 1px),
      linear-gradient(90deg,rgba(112,205,255,.07) 1px,transparent 1px);
      background-size:54px 54px;mask-image:linear-gradient(to bottom,black,transparent 88%)}
    body::after{content:"";position:fixed;inset:-20%;pointer-events:none;background:conic-gradient(from 180deg at 50% 50%,transparent 0 24%,rgba(77,144,255,.08) 31%,transparent 38% 66%,rgba(103,226,255,.07) 73%,transparent 80%);animation:auroraSpin 28s linear infinite}
    .ambient{position:fixed;inset:0;overflow:hidden;pointer-events:none}
    .orb{position:absolute;border-radius:50%;filter:blur(2px);opacity:.72}
    .orb.one{width:310px;height:310px;left:-110px;top:10%;border:1px solid rgba(102,217,255,.24);box-shadow:inset 0 0 90px rgba(75,141,255,.12),0 0 80px rgba(75,141,255,.1);animation:orbDrift 11s ease-in-out infinite}
    .orb.two{width:210px;height:210px;right:-42px;bottom:7%;border:1px solid rgba(139,108,255,.3);box-shadow:inset 0 0 72px rgba(139,108,255,.13),0 0 70px rgba(139,108,255,.12);animation:orbDrift 9s ease-in-out infinite reverse}
    .particle{position:absolute;width:5px;height:5px;border-radius:50%;background:var(--cyan);box-shadow:0 0 18px 4px rgba(102,217,255,.46);animation:particleFloat 8s ease-in-out infinite}
    .particle.p1{left:10%;top:74%}.particle.p2{left:28%;top:12%;animation-delay:-3s}.particle.p3{right:18%;top:18%;animation-delay:-5s}.particle.p4{right:8%;top:58%;animation-delay:-1.5s}
    .login-shell{position:relative;z-index:1;width:min(1080px,100%);min-height:650px;display:grid;grid-template-columns:1.08fr .92fr;overflow:hidden;border:1px solid rgba(135,215,255,.25);border-radius:34px;background:linear-gradient(135deg,rgba(10,30,49,.78),rgba(4,14,27,.9));box-shadow:0 42px 120px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.025) inset,0 0 80px rgba(62,133,224,.08);backdrop-filter:blur(26px);animation:shellFloat 8s ease-in-out infinite}
    .login-shell::before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,rgba(255,255,255,.06),transparent 21% 74%,rgba(102,217,255,.035))}
    .command-panel{position:relative;display:flex;flex-direction:column;justify-content:flex-end;padding:42px 50px;overflow:hidden;border-right:1px solid rgba(125,210,255,.15);background:radial-gradient(circle at 48% 45%,rgba(55,122,213,.16),transparent 42%)}
    .hero-logo{position:relative;z-index:2;display:grid;flex:1;place-items:center;min-height:470px}
    .unigames-emblem{position:relative;display:grid;place-items:center;width:min(310px,64%);aspect-ratio:1;padding:24px;box-sizing:border-box;border:1px solid rgba(102,217,255,.16);border-radius:38px;background:rgba(4,19,33,.48);box-shadow:0 30px 75px rgba(0,0,0,.34),0 0 54px rgba(102,217,255,.19);animation:logoFloat 5.5s ease-in-out infinite}
    .unigames-emblem::before{content:"";position:absolute;inset:-12px;border:1px solid rgba(102,217,255,.22);border-radius:46px;box-shadow:0 0 34px rgba(102,217,255,.11);animation:pulseRing 3.4s ease-out infinite}
    .unigames-emblem img{display:block;width:100%;height:100%;object-fit:contain;border-radius:0;filter:drop-shadow(0 14px 24px rgba(0,0,0,.2))}
    .tech-core{position:absolute;left:50%;top:46%;width:390px;height:390px;transform:translate(-50%,-50%);opacity:.82;pointer-events:none}.tech-ring{position:absolute;inset:0;border:1px solid rgba(102,217,255,.18);border-radius:50%;animation:ringSpin 18s linear infinite}.tech-ring::before,.tech-ring::after{content:"";position:absolute;border-radius:50%;background:var(--cyan);box-shadow:0 0 18px var(--cyan)}.tech-ring::before{width:7px;height:7px;left:48px;top:33px}.tech-ring::after{width:4px;height:4px;right:22px;bottom:95px}.tech-ring.mid{inset:50px;border-style:dashed;border-color:rgba(139,108,255,.26);animation-duration:12s;animation-direction:reverse}.tech-ring.inner{inset:113px;border-color:rgba(101,247,206,.25);animation-duration:8s}.core-light{position:absolute;inset:148px;border-radius:50%;background:radial-gradient(circle,#bdf5ff 0,#66d9ff 16%,rgba(75,141,255,.28) 44%,transparent 72%);box-shadow:0 0 54px rgba(102,217,255,.38);animation:corePulse 3.2s ease-in-out infinite}
    .system-stats{position:relative;z-index:2;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat{padding:14px 13px;border:1px solid rgba(125,210,255,.15);border-radius:14px;background:rgba(7,23,38,.58);box-shadow:0 13px 30px rgba(0,0,0,.14);backdrop-filter:blur(12px);animation:chipFloat 5.5s ease-in-out infinite}.stat:nth-child(2){animation-delay:-1.8s}.stat:nth-child(3){animation-delay:-3.4s}.stat strong{display:block;color:#dff7ff;font-size:11px;letter-spacing:.07em}.stat span{display:flex;align-items:center;gap:6px;margin-top:5px;color:#7795ac;font-size:9px;letter-spacing:.09em;text-transform:uppercase}.stat span::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--mint);box-shadow:0 0 10px rgba(101,247,206,.72)}
    .auth-zone{position:relative;display:grid;place-items:center;padding:46px}.auth-zone::before{content:"";position:absolute;width:240px;height:240px;right:-70px;top:-80px;border:1px solid rgba(102,217,255,.13);border-radius:50%;box-shadow:0 0 60px rgba(75,141,255,.07)}
    .auth-card{position:relative;width:min(390px,100%);padding:33px;border:1px solid rgba(148,220,255,.19);border-radius:25px;background:linear-gradient(160deg,rgba(14,35,55,.88),rgba(5,17,31,.93));box-shadow:0 28px 65px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.045);backdrop-filter:blur(22px);animation:cardFloat 6.5s ease-in-out infinite}
    .auth-card::before{content:"";position:absolute;inset:-1px;border-radius:25px;padding:1px;background:linear-gradient(135deg,rgba(102,217,255,.54),transparent 30% 70%,rgba(139,108,255,.4));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
    .access-status{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid rgba(101,247,206,.2);border-radius:999px;background:rgba(101,247,206,.055);color:#9df9df;font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.access-status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--mint);box-shadow:0 0 12px rgba(101,247,206,.8);animation:statusBlink 2s ease-in-out infinite}
    .auth-card h2{margin:23px 0 8px;font-size:29px;letter-spacing:-.035em}.intro{margin:0 0 24px;color:var(--soft);font-size:13px;line-height:1.55}
    .notice{margin:0 0 18px;padding:12px 13px;border:1px solid rgba(255,112,140,.38);border-radius:12px;background:rgba(126,28,58,.19);color:#ffd6df;font-size:12px;line-height:1.45}
    label{display:flex;justify-content:space-between;margin:15px 0 8px;color:#ccecff;font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.label-code{color:#536f86;font-weight:700}
    .field{position:relative}.field-icon{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:#7199b7;font-size:15px;pointer-events:none}.field::after{content:"";position:absolute;left:43px;top:13px;bottom:13px;width:1px;background:rgba(125,210,255,.13)}
    input{width:100%;min-height:50px;border:1px solid rgba(125,210,255,.2);border-radius:13px;background:rgba(2,12,23,.75);color:var(--ink);padding:13px 14px 13px 56px;font:inherit;font-size:16px;outline:none;transition:border-color .2s,box-shadow .2s,background .2s}input::placeholder{color:#49647a}input:hover{border-color:rgba(125,210,255,.32)}input:focus{border-color:rgba(102,217,255,.75);background:rgba(4,17,30,.92);box-shadow:0 0 0 3px rgba(102,217,255,.09),0 0 24px rgba(102,217,255,.08)}
    button{position:relative;width:100%;min-height:51px;margin-top:22px;overflow:hidden;border:0;border-radius:13px;padding:14px 18px;background:linear-gradient(110deg,#55c9f3,#5f9cff 56%,#8170f5);color:#03101d;font-weight:950;font-size:12px;letter-spacing:.09em;text-transform:uppercase;cursor:pointer;box-shadow:0 14px 32px rgba(76,145,245,.26);transition:transform .2s,filter .2s,box-shadow .2s}button::before{content:"";position:absolute;inset:0;transform:translateX(-120%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.42),transparent);transition:transform .6s}button:hover{transform:translateY(-2px);filter:brightness(1.07);box-shadow:0 18px 38px rgba(76,145,245,.36)}button:hover::before{transform:translateX(120%)}button:disabled{opacity:.45;cursor:not-allowed;transform:none}
    .form-links{display:flex;justify-content:center;margin-top:17px}.help{color:#9edfff;font-size:11px;font-weight:800;letter-spacing:.04em;text-decoration:none}.help:hover{text-decoration:underline}.security{display:flex;align-items:flex-start;gap:9px;margin:22px 0 0;padding-top:18px;border-top:1px solid rgba(125,210,255,.1);color:#627f96;font-size:10px;line-height:1.5}.security-icon{color:#7bbddf;font-size:13px}
    @keyframes shellFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}@keyframes cardFloat{0%,100%{transform:translateY(0) rotateX(0)}50%{transform:translateY(-8px) rotateX(.6deg)}}@keyframes logoFloat{0%,100%{transform:translateY(0) rotate(-.4deg)}50%{transform:translateY(-11px) rotate(.4deg)}}@keyframes chipFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}@keyframes orbDrift{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(20px,-18px) scale(1.05)}}@keyframes particleFloat{0%,100%{transform:translateY(0);opacity:.35}50%{transform:translateY(-30px);opacity:1}}@keyframes ringSpin{to{transform:rotate(360deg)}}@keyframes auroraSpin{to{transform:rotate(360deg)}}@keyframes pulseRing{0%{transform:scale(.84);opacity:0}55%{opacity:.75}100%{transform:scale(1.16);opacity:0}}@keyframes corePulse{0%,100%{transform:scale(.88);opacity:.7}50%{transform:scale(1.08);opacity:1}}@keyframes statusBlink{0%,100%{opacity:.48}50%{opacity:1}}
    @media(max-width:860px){body{padding:20px}.login-shell{width:min(520px,100%);grid-template-columns:1fr;min-height:0;backdrop-filter:blur(14px)}.command-panel{min-height:270px;padding:24px;border-right:0;border-bottom:1px solid rgba(125,210,255,.15)}.hero-logo{min-height:220px}.unigames-emblem{width:168px;padding:14px;border-radius:26px}.unigames-emblem::before{border-radius:34px}.system-stats{display:none}.tech-core{width:230px;height:230px;left:50%;top:50%}.tech-ring.mid{inset:32px}.tech-ring.inner{inset:70px}.core-light{inset:88px}.auth-zone{padding:25px}.auth-card{width:100%;animation:none;backdrop-filter:blur(12px)}}
    @media(max-width:520px){body{align-items:start;padding:13px}.login-shell{margin:8px 0;border-radius:24px;animation:none;backdrop-filter:none}.command-panel{min-height:225px;padding:20px}.hero-logo{min-height:185px}.unigames-emblem{width:146px;padding:12px;border-radius:23px}.unigames-emblem::before{border-radius:31px}.tech-core{left:50%;top:50%;width:185px;height:185px}.tech-ring.mid{inset:27px}.tech-ring.inner{inset:58px}.core-light{inset:72px}.auth-zone{padding:14px}.auth-card{padding:25px 20px;border-radius:20px;backdrop-filter:none}.auth-card::before{border-radius:20px}.auth-card h2{font-size:26px}.orb.one{width:220px;height:220px}.orb.two{width:150px;height:150px}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;scroll-behavior:auto!important}button{transition:none}}
  </style>
</head>
<body>
  <div class="ambient" aria-hidden="true">
    <span class="orb one"></span><span class="orb two"></span>
    <span class="particle p1"></span><span class="particle p2"></span><span class="particle p3"></span><span class="particle p4"></span>
  </div>
  <main class="login-shell">
    <section class="command-panel" aria-label="Unigames">
      <div class="tech-core" aria-hidden="true"><span class="tech-ring"></span><span class="tech-ring mid"></span><span class="tech-ring inner"></span><span class="core-light"></span></div>
      <div class="hero-logo"><div class="unigames-emblem"><img src="/unigames-logo.png" alt="Unigames"></div></div>
      <div class="system-stats" aria-label="Estado da plataforma">
        <div class="stat"><strong>SISTEMA</strong><span>Operacional</span></div>
        <div class="stat"><strong>DADOS</strong><span>Sincronizados</span></div>
        <div class="stat"><strong>ACESSO</strong><span>Protegido</span></div>
      </div>
    </section>
    <section class="auth-zone">
      <div class="auth-card">
        <span class="access-status">Canal seguro ativo</span>
        <h2>Acesse sua central</h2>
        <p class="intro">Use suas credenciais individuais para carregar seus módulos, preferências e tarefas.</p>
        ${notice}
        <form method="post" action="/login">
          <input type="hidden" name="next" value="${escapeHtml(next)}">
          <label for="username"><span>Usuário</span><span class="label-code">ID.01</span></label>
          <div class="field"><span class="field-icon" aria-hidden="true">●</span><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Digite seu usuário" required${disabled}></div>
          <label for="password"><span>Senha</span><span class="label-code">KEY.02</span></label>
          <div class="field"><span class="field-icon" aria-hidden="true">◆</span><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Digite sua senha" required${disabled}></div>
          <button type="submit"${disabled}>Entrar no sistema&nbsp;&nbsp;→</button>
        </form>
        <div class="form-links"><a class="help" href="/recuperar-senha">Esqueci minha senha</a></div>
        <p class="security"><span class="security-icon" aria-hidden="true">◈</span><span>Sessão criptografada e válida por 12 horas. Suas permissões são verificadas novamente a cada acesso.</span></p>
      </div>
    </section>
  </main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function passwordRecoveryPage(message = "", success = false): Response {
  const notice = message
    ? `<div class="notice ${success ? "success" : ""}" role="status">${escapeHtml(message)}</div>`
    : "";
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#050d18">
<link rel="icon" type="image/png" href="/icon-32.png"><link rel="apple-touch-icon" href="/icon-180.png">
<title>Recuperar senha · Central Unigames</title>
<style>
:root{color-scheme:dark;--bg:#030914;--cyan:#66d9ff;--blue:#4b8dff;--violet:#8b6cff;--ink:#f5fbff;--soft:#9eb5c9}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;overflow-x:hidden;padding:24px;background:radial-gradient(circle at 12% 15%,rgba(64,122,211,.24),transparent 32%),radial-gradient(circle at 88% 84%,rgba(103,77,198,.2),transparent 32%),linear-gradient(145deg,#030914,#071625 55%,#020711);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.35;background-image:linear-gradient(rgba(112,205,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(112,205,255,.07) 1px,transparent 1px);background-size:54px 54px;mask-image:linear-gradient(to bottom,black,transparent 90%)}
.recovery-orbit{position:fixed;width:430px;height:430px;border:1px solid rgba(102,217,255,.15);border-radius:50%;pointer-events:none;animation:orbitFloat 9s ease-in-out infinite}.recovery-orbit::before,.recovery-orbit::after{content:"";position:absolute;border-radius:50%;border:1px dashed rgba(139,108,255,.17)}.recovery-orbit::before{inset:52px}.recovery-orbit::after{inset:115px;background:radial-gradient(circle,rgba(102,217,255,.12),transparent 65%);box-shadow:0 0 70px rgba(75,141,255,.09)}
main{position:relative;z-index:1;width:min(480px,100%);padding:38px;border:1px solid rgba(135,215,255,.24);border-radius:28px;background:linear-gradient(145deg,rgba(13,34,53,.88),rgba(4,15,28,.94));box-shadow:0 36px 100px rgba(0,0,0,.53),inset 0 1px rgba(255,255,255,.045);backdrop-filter:blur(25px);animation:cardFloat 7s ease-in-out infinite}
main::before{content:"";position:absolute;inset:-1px;border-radius:28px;padding:1px;background:linear-gradient(135deg,rgba(102,217,255,.55),transparent 33% 70%,rgba(139,108,255,.38));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.brand{display:flex;align-items:center;gap:14px}.brand-icon{position:relative;display:grid;place-items:center;width:55px;height:55px;border:1px solid rgba(102,217,255,.46);border-radius:17px;background:rgba(102,217,255,.08);box-shadow:0 0 27px rgba(102,217,255,.13)}.brand-icon::after{content:"";position:absolute;inset:-6px;border:1px solid rgba(102,217,255,.12);border-radius:22px;animation:pulse 3s ease-out infinite}.brand img{width:35px;height:35px}.kicker{margin:0 0 4px;color:var(--cyan);font-size:9px;font-weight:900;letter-spacing:.18em}.brand h1{margin:0;font-size:24px;letter-spacing:-.025em}.brand small{display:block;margin-top:3px;color:#718da3;font-size:10px}
.intro{margin:26px 0 21px;color:var(--soft);font-size:13px;line-height:1.65}.step{display:inline-flex;align-items:center;gap:8px;margin-bottom:5px;color:#a8ebff;font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.step::before{content:"";width:7px;height:7px;border-radius:50%;background:#65f7ce;box-shadow:0 0 11px rgba(101,247,206,.72)}
label{display:flex;justify-content:space-between;margin:17px 0 8px;color:#ccecff;font-size:10px;font-weight:900;letter-spacing:.12em}.field{position:relative}.field::before{content:"●";position:absolute;left:16px;top:50%;transform:translateY(-50%);color:#7199b7;font-size:14px}.field::after{content:"";position:absolute;left:43px;top:13px;bottom:13px;width:1px;background:rgba(125,210,255,.13)}
input{width:100%;min-height:51px;padding:13px 14px 13px 56px;border:1px solid rgba(125,210,255,.21);border-radius:13px;background:rgba(2,12,23,.78);color:var(--ink);font:inherit;font-size:16px;outline:none}input:focus{border-color:rgba(102,217,255,.74);box-shadow:0 0 0 3px rgba(102,217,255,.09),0 0 25px rgba(102,217,255,.07)}
button{position:relative;width:100%;min-height:51px;margin-top:21px;overflow:hidden;padding:14px;border:0;border-radius:13px;background:linear-gradient(110deg,#55c9f3,#5f9cff 56%,#8170f5);color:#03101d;font-weight:950;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;box-shadow:0 15px 34px rgba(76,145,245,.26);transition:transform .2s,filter .2s}button:hover{transform:translateY(-2px);filter:brightness(1.08)}.back{display:block;margin-top:19px;color:#9fdfff;text-align:center;text-decoration:none;font-size:11px;font-weight:800}.back:hover{text-decoration:underline}
.notice{margin:18px 0 0;padding:12px 13px;border:1px solid rgba(255,112,140,.38);border-radius:12px;background:rgba(126,28,58,.2);color:#ffd6df;font-size:12px;line-height:1.45}.notice.success{border-color:rgba(92,211,151,.4);background:rgba(21,96,62,.22);color:#c9ffe3}
@keyframes cardFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}@keyframes orbitFloat{0%,100%{transform:rotate(0) scale(1)}50%{transform:rotate(12deg) scale(1.04)}}@keyframes pulse{0%{transform:scale(.84);opacity:0}55%{opacity:.7}100%{transform:scale(1.16);opacity:0}}@media(max-width:520px){body{padding:14px}main{padding:29px 21px;border-radius:22px;animation:none}.recovery-orbit{width:300px;height:300px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}}
</style></head><body><span class="recovery-orbit" aria-hidden="true"></span><main>
<div class="brand"><div class="brand-icon"><img src="/favicon.svg" alt=""></div><div><p class="kicker">UNIGAMES // ACCESS</p><h1>Recuperar senha</h1><small>Central de Operações</small></div></div>
<p class="intro"><span class="step">Solicitação protegida</span><br>Informe seu usuário. O administrador receberá o pedido e poderá cadastrar uma nova senha com segurança.</p>
${notice}
<form method="post" action="/recuperar-senha">
<label for="username"><span>USUÁRIO DE LOGIN</span><span>REC.01</span></label>
<div class="field"><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="40" placeholder="Digite seu usuário" required></div>
<button type="submit">Solicitar recuperação&nbsp;&nbsp;→</button>
</form>
<a class="back" href="/login">← Voltar para entrar</a>
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

async function handlePasswordRecovery(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    return passwordRecoveryPage();
  }
  if (request.method !== "POST") {
    return new Response("Método não permitido", {
      status: 405,
      headers: { allow: "GET, HEAD, POST" },
    });
  }
  if (!sameOrigin(request, url)) {
    return jsonError("ORIGEM DA SOLICITAÇÃO NÃO PERMITIDA.", 403);
  }
  if (isRateLimited(request)) {
    return passwordRecoveryPage("Muitas solicitações. Aguarde alguns minutos e tente novamente.");
  }
  try {
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    const row = await readUserByUsername(env.DB, username);
    if (row && row.active === 1) {
      const pending = await env.DB
        .prepare(
          "SELECT id FROM password_reset_requests WHERE user_id=?1 AND status='pending' LIMIT 1",
        )
        .bind(row.id)
        .first<{ id: string }>();
      if (!pending) {
        await env.DB
          .prepare(
            `INSERT INTO password_reset_requests (id, user_id, status, requested_at)
             VALUES (?1, ?2, 'pending', CURRENT_TIMESTAMP)`,
          )
          .bind(crypto.randomUUID(), row.id)
          .run();
      }
    }
    clearFailures(request);
    return passwordRecoveryPage(
      "Solicitação registrada. Peça ao administrador para definir uma nova senha no cadastro do usuário.",
      true,
    );
  } catch {
    recordFailure(request);
    return passwordRecoveryPage("Não foi possível registrar a solicitação agora. Tente novamente.");
  }
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
    let existingUser: AuthenticatedUser | null = null;
    try {
      existingUser = await authenticatedUser(request, env, config);
    } catch (error) {
      if (!(error instanceof SessionLookupError)) throw error;
      // Nao foi possivel confirmar a sessao (banco indisponivel/sobrecarregado).
      // Mostra a tela de login normalmente em vez de assumir sessao invalida.
    }
    if (existingUser) {
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
  if (!sameOrigin(request, url)) {
    return jsonError("ORIGEM DA SOLICITAÇÃO NÃO PERMITIDA.", 403);
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
  if (!sameOrigin(request, url)) {
    return jsonError("ORIGEM DA SOLICITAÇÃO NÃO PERMITIDA.", 403);
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

function serviceUnavailable(url: URL): Response {
  const message = "NAO FOI POSSIVEL VALIDAR O ACESSO NO MOMENTO. TENTE NOVAMENTE.";
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: message }, { status: 503 });
  }
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Serviço indisponível</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#06111d;color:#f5f9ff;font-family:Arial,sans-serif;padding:24px}.card{max-width:520px;padding:32px;border:1px solid #2b5f8f;border-radius:18px;background:#0b1b2c;text-align:center}h1{font-size:24px}p{color:#a9bfd3;line-height:1.55}</style></head><body><main class="card"><h1>Serviço indisponível</h1><p>Não foi possível validar seu acesso agora. Aguarde alguns segundos e recarregue a página.</p></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function forbidden(url: URL): Response {
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

function sharedStatePermission(key: string, scope: string, write: boolean): Permission | Permission[] {
  const normalized = `${scope}:${key}`.toLowerCase();
  if (normalized.includes("tarefa")) return write ? "tasks:manage" : ["tasks:view", "tasks:manage"];
  if (normalized.includes("puxada")) return write ? "pulls:view" : ["pulls:view", "report41:view"];
  if (key === "report41:company-stock") {
    return write ? "database:manage" : ["database:view", "report41:view"];
  }
  if (/^report41:store:c[a-z0-9]{6,40}$/i.test(key)) return "report41:view";
  return write
    ? ["stock:view", "database:manage", "pulls:view"]
    : ["stock:view", "database:view", "pulls:view", "report41:view"];
}

// Chaves de permissão que, em conjunto, liberam a página/API grossa de cada
// módulo — a checagem fina de qual ação (criar/editar/excluir/...) é feita
// dentro do handler da rota correspondente em app/api/*.
const MODULE_VIEW_PERMISSIONS: Record<string, Permission[]> = {
  tasks: ["tasks:view", "tasks:manage"],
  missions: ["missions:view", "missions:create", "missions:delete", "missions:notify"],
  captures: ["captures:view", "captures:create", "captures:receive", "captures:assign", "captures:delete"],
  outputs: ["outputs:view", "outputs:create", "outputs:complete", "outputs:delete"],
  inputs: ["inputs:view", "inputs:create", "inputs:complete", "inputs:delete"],
  supplies: [
    "supplies:view", "supplies:request", "supplies:receive",
    "supplies:stock_in", "supplies:stock_out", "supplies:delete", "supplies:manage_catalog",
  ],
  purchases: ["purchases:view", "purchases:create", "purchases:edit", "purchases:delete", "purchases:send_to_finance"],
  stock: ["stock:view"],
  pulls: ["pulls:view"],
  report41: ["report41:view"],
  database: ["database:view", "database:manage"],
  pdvRequests: [
    "pdv_requests:view", "pdv_requests:create", "pdv_requests:delete", "pdv_requests:status",
  ],
  osNotes: [
    "os_notes:view", "os_notes:create", "os_notes:attach", "os_notes:delete",
  ],
  finance: [
    "finance:manage",
    "payables:invoices_view", "payables:invoices_reconcile", "payables:confirm_payment", "payables:return_to_purchases",
  ],
  payroll: ["payroll:manage"],
  loans: [
    "loans:view", "loans:create", "loans:edit", "loans:delete", "loans:request", "loans:manage_requests",
  ],
};

const LIVE_MODULE_PERMISSION_KEYS: Record<LiveModule, keyof typeof MODULE_VIEW_PERMISSIONS> = {
  missions: "missions",
  captures: "captures",
  supplies: "supplies",
  tasks: "tasks",
  loans: "loans",
};

async function isAllowed(request: Request, url: URL, user: AuthenticatedUser): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/live") {
    const liveModuleName = url.searchParams.get("module");
    return isLiveModule(liveModuleName) &&
      hasAnyPermission(
        user,
        MODULE_VIEW_PERMISSIONS[LIVE_MODULE_PERMISSION_KEYS[liveModuleName]],
      );
  }
  if (path === "/cadastros/usuarios" || path === "/administracao/usuarios" || path === "/api/admin/users") {
    return user.role === "admin" || hasPermission(user, "users:manage");
  }
  if (path === "/instrucoes" || (path.startsWith("/api/instructions") && (request.method === "GET" || request.method === "HEAD"))) {
    return true;
  }
  if (path.startsWith("/api/instructions")) {
    return hasPermission(user, "instructions:manage");
  }
  if (path === "/documentos" || path.startsWith("/documentos/")) {
    return true;
  }
  if (path.startsWith("/api/documents")) {
    return request.method === "GET" || request.method === "HEAD"
      ? true
      : hasPermission(user, "documents_manage");
  }
  const directPermissions: Array<[boolean, keyof typeof MODULE_VIEW_PERMISSIONS]> = [
    [path === "/tarefas", "tasks"],
    [path === "/missoes" || path.startsWith("/api/missions"), "missions"],
    [path.startsWith("/api/routines"), "missions"],
    [path.startsWith("/api/checklists"), "missions"],
    [path === "/captacao" || path.startsWith("/api/captures"), "captures"],
    [path === "/saidas" || path.startsWith("/api/outputs"), "outputs"],
    [path === "/entradas" || path.startsWith("/api/inputs"), "inputs"],
    [path === "/insumos" || path.startsWith("/api/supplies"), "supplies"],
    [path === "/aparelhos-emprestimo" || path.startsWith("/api/loans"), "loans"],
    [path === "/compras" || path.startsWith("/api/compras"), "purchases"],
    [path === "/estoque", "stock"],
    [path === "/puxadas", "pulls"],
    [path === "/relatorio-41", "report41"],
    [path === "/cadastros" || path.startsWith("/cadastros/"), "database"],
    [
      path === "/solicitacoes/alteracoes-pdv" || path.startsWith("/api/pdv-requests"),
      "pdvRequests",
    ],
    [
      path === "/solicitacoes/notas-os" || path.startsWith("/api/os-notes"),
      "osNotes",
    ],
    [
      path === "/financeiro" || path.startsWith("/financeiro/") || path.startsWith("/api/finance"),
      "finance",
    ],
    // RH Financeiro: as quatro telas novas (Funcionários, Folha, Benefícios
    // e Comissionamento) e a API delas só dependem de payroll:manage — nem
    // do "hr" das telas de Folgas/Escalas, nem de finance:manage.
    [
      path === "/rh/funcionarios" ||
        path === "/rh/folha" ||
        path === "/rh/beneficios" ||
        path === "/rh/comissionamento" ||
        path.startsWith("/api/hr-payroll"),
      "payroll",
    ],
  ];
  const direct = directPermissions.find(([matches]) => matches);
  if (direct) return hasAnyPermission(user, MODULE_VIEW_PERMISSIONS[direct[1]]);
  if (path.startsWith("/api/backup")) {
    // Exportar/restaurar backup mexe em todos os dados compartilhados de
    // uma vez só, então fica restrito à conta raiz (env-admin) — nem
    // mesmo outras contas com grupo "Administrador" podem usar.
    return user.id === "env-admin";
  }
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
    // Autoteste de conexão exibido para qualquer usuário logado (caixa
    // "DADOS COMPARTILHADOS" na sidebar, sem gate de módulo no HTML) — não
    // deve depender de permissão de nenhum módulo específico.
    if (key === "__shared_health__") return true;
    // A LEITURA da lista de lojas (id+nome, sem dado sensível) é usada por
    // vários módulos pra deixar quem não tem loja escolher a loja de
    // destino (Saídas, Captação, Missões, Insumos...) — gateá-la atrás de
    // stock/database/pulls/report41 (só o que o branch padrão abaixo
    // libera) deixava esses usuários com o seletor de loja sempre vazio,
    // mesmo com a permissão certa do próprio módulo. A escrita (Cadastros
    // > Lojas) continua restrita normalmente pelo branch padrão.
    if (key === "companies_list" && (request.method === "GET" || request.method === "HEAD")) {
      return true;
    }
    const required = sharedStatePermission(
      key,
      scope,
      request.method !== "GET" && request.method !== "HEAD",
    );
    const reportStoreMatch = /^report41:store:(c[a-z0-9]{6,40})$/i.exec(key);
    if (reportStoreMatch && user.role !== "admin") {
      // Usuário vinculado a uma loja só acessa o relatório da própria loja.
      // Usuário SEM loja mas com report41:view acessa qualquer loja, igual
      // ao administrador — mesma regra geral aplicada a todos os módulos.
      const boundToOwnStore = Boolean(user.companyId) && reportStoreMatch[1] === user.companyId;
      const hasFullAccessWithoutCompany = !user.companyId && hasPermission(user, "report41:view");
      if (!boundToOwnStore && !hasFullAccessWithoutCompany) return false;
    }
    return Array.isArray(required) ? hasAnyPermission(user, required) : hasPermission(user, required);
  }
  return true;
}

function liveConnectionGroups(user: AuthenticatedUser): string[] {
  const groups: string[] = [];
  // Canal de aviso em tempo real p/ quem pode receber/preparar captações —
  // baseado só na permissão granular, não mais em setor/grupo/nome de
  // usuário (o fluxo especial de "assistência" foi removido).
  if (hasPermission(user, "captures:receive")) groups.push("assistance");
  // Nenhuma conta real usa role="admin" literal (só a conta raiz/env-admin) —
  // quem gerencia solicitações de aparelho é sempre um usuário "user" com
  // permissão granular concedida. Sem essa tag, o aviso "company" de uma
  // nova solicitação (que só alcança role:admin + a própria loja) nunca
  // chegaria em quem de fato aprova as solicitações.
  if (hasPermission(user, "loans:manage_requests")) groups.push("loans_manage");
  return groups;
}

function connectLiveUpdates(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
  module: LiveModule,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set("x-live-user-id", user.id);
  headers.set("x-live-role", user.role);
  headers.set("x-live-company-id", user.companyId);
  headers.set("x-live-groups", liveConnectionGroups(user).join(","));
  const liveRequest = new Request(request, { headers });
  return env.LIVE_UPDATES.getByName(module).fetch(liveRequest);
}

async function publishLiveUpdate(env: Env, invalidation: LiveInvalidation): Promise<void> {
  const response = await env.LIVE_UPDATES.getByName(invalidation.module).fetch(
    "https://live.internal/publish",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalidation),
    },
  );
  if (!response.ok) throw new Error(`Falha ao publicar atualizacao ao vivo: ${response.status}`);
}

function sessionResponse(user: AuthenticatedUser): Response {
  return Response.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    companyId: user.companyId,
    sector: user.sector,
    accessGroup: user.accessGroup,
    role: user.role,
    permissions: user.permissions,
  }, { headers: { "cache-control": "no-store" } });
}

function validUsername(value: string): boolean {
  return /^[a-z0-9._-]{3,40}$/i.test(value);
}

function sameOrigin(request: Request, url: URL): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (origin) {
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
  return !fetchSite || fetchSite === "none";
}

function publicUser(row: StoredUserRow) {
  const role = row.role === "admin" ? "admin" : "user";
  const accessGroup = role === "admin" ? "administrator" : normalizeAccessGroup(row.accessGroup);
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    companyId: row.companyId || "",
    hierarchy: normalizeHierarchy(row.hierarchy),
    sector: normalizeSector(row.sector),
    role,
    accessGroup,
    permissions: role === "admin"
      ? [...ALL_PERMISSIONS]
      : accessGroup === "custom"
        ? permissionsFromJson(row.permissionsJson)
        : [...ACCESS_GROUP_PERMISSIONS[accessGroup]],
    active: row.active === 1,
    recoveryRequested: row.recoveryRequested === 1,
    managed: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listUsers(env: Env, config: LoginConfig): Promise<Response> {
  await ensureAppUsersTable(env.DB);
  const result = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, password_hash AS passwordHash,
            email, password_salt AS passwordSalt, role, access_group AS accessGroup,
            permissions_json AS permissionsJson, company_id AS companyId, hierarchy, sector,
            active, session_version AS sessionVersion, created_at AS createdAt,
            updated_at AS updatedAt,
            CASE WHEN EXISTS(
              SELECT 1 FROM password_reset_requests request
              WHERE request.user_id = app_users.id AND request.status = 'pending'
            ) THEN 1 ELSE 0 END AS recoveryRequested
     FROM app_users ORDER BY lower(display_name)`,
  ).all<StoredUserRow>();
  return Response.json({
    users: [{
      id: "env-admin",
      username: config.username,
      displayName: "Administrador principal",
      email: "",
      companyId: "",
      hierarchy: "director",
      sector: "",
      role: "admin",
      accessGroup: "administrator",
      permissions: ALL_PERMISSIONS,
      active: true,
      recoveryRequested: false,
      managed: false,
    }, ...(result.results ?? []).map(publicUser)],
  });
}

async function handleAdminUsers(
  request: Request,
  env: Env,
  url: URL,
  config: LoginConfig,
  actor: AuthenticatedUser,
): Promise<Response> {
  try {
    await ensureAppUsersTable(env.DB);
  } catch (error) {
    console.error("Não foi possível preparar a tabela de usuários.", error);
    return jsonError("NÃO FOI POSSÍVEL PREPARAR O CADASTRO DE USUÁRIOS.", 500);
  }
  if (request.method === "GET") return listUsers(env, config);
  if (!sameOrigin(request, url)) return jsonError("ORIGEM DA SOLICITAÇÃO NÃO PERMITIDA.", 403);
  if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") {
    return new Response("Método não permitido", { status: 405, headers: { allow: "GET, POST, PATCH, DELETE" } });
  }
  // Só o administrador de verdade (role="admin") pode mexer com outro
  // administrador ou com quem tem/vai ter "users:manage" — um titular de
  // "users:manage" via permissão custom pode gerenciar usuários comuns, mas
  // nunca se autopromover, promover outros a admin, ou conceder/alterar essa
  // mesma permissão em ninguém (evita escalonamento de privilégio).
  const actorIsSuperAdmin = actor.role === "admin";

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (!id || id === "env-admin") {
      return jsonError("O ADMINISTRADOR PRINCIPAL NÃO PODE SER EXCLUÍDO.", 400);
    }
    try {
      const existing = await readUserById(env.DB, id);
      if (!existing) return jsonError("USUÁRIO NÃO ENCONTRADO.", 404);
      if (!actorIsSuperAdmin && (existing.role === "admin" || permissionsFromJson(existing.permissionsJson).includes("users:manage"))) {
        return jsonError("SOMENTE O ADMINISTRADOR PRINCIPAL PODE EXCLUIR ESTE USUÁRIO.", 403);
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM password_reset_requests WHERE user_id = ?1").bind(id),
        env.DB.prepare("DELETE FROM user_preferences WHERE user_id = ?1").bind(id),
        env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1").bind(id),
        env.DB.prepare("DELETE FROM app_users WHERE id = ?1").bind(id),
      ]);
      return Response.json({ deleted: true, id });
    } catch (error) {
      console.error("Não foi possível excluir o usuário.", error);
      return jsonError("NÃO FOI POSSÍVEL EXCLUIR O USUÁRIO.", 500);
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError("DADOS INVÁLIDOS.", 400);
  }

  const username = String(body.username ?? "").trim().toLowerCase();
  const displayName = String(body.displayName ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
  const password = String(body.password ?? "");
  const requestedCompanyId = /^c[a-z0-9]{6,40}$/i.test(String(body.companyId ?? "").trim())
    ? String(body.companyId ?? "").trim()
    : "";
  const accessGroup = normalizeAccessGroup(body.accessGroup);
  const hierarchy = normalizeHierarchy(body.hierarchy);
  const requestedSector = normalizeSector(body.sector);
  const sector: UserSector = accessGroup === "assistance" ? "assistance" : requestedSector;
  const companyId = sector ? "" : requestedCompanyId;
  const access = accessForGroup(accessGroup, body.permissions);
  if (!validUsername(username)) {
    return jsonError("O USUÁRIO DEVE TER DE 3 A 40 CARACTERES: LETRAS, NÚMEROS, PONTO, HÍFEN OU _.", 400);
  }
  if (displayName.length < 2 || displayName.length > 80) {
    return jsonError("INFORME UM NOME ENTRE 2 E 80 CARACTERES.", 400);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonError("INFORME UM E-MAIL VÁLIDO OU DEIXE O CAMPO VAZIO.", 400);
  }
  if (!actorIsSuperAdmin && accessGroup === "administrator") {
    return jsonError("SOMENTE O ADMINISTRADOR PRINCIPAL PODE CONCEDER ACESSO DE ADMINISTRADOR.", 403);
  }

  try {
    if (request.method === "POST") {
      // Usuário novo nunca "já tinha" users:manage — conceder essa
      // permissão aqui é sempre uma escalação de privilégio nova.
      if (!actorIsSuperAdmin && access.permissions.includes("users:manage")) {
        return jsonError("SOMENTE O ADMINISTRADOR PRINCIPAL PODE CONCEDER GERENCIAMENTO DE USUÁRIOS.", 403);
      }
      if (password.length < 8 || password.length > 200) {
        return jsonError("A SENHA DEVE TER PELO MENOS 8 CARACTERES.", 400);
      }
      const credential = await hashPassword(password);
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO app_users
          (id, username, display_name, email, password_hash, password_salt, role,
           access_group, permissions_json, company_id, hierarchy, sector, active, session_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, 1)`,
      ).bind(
        id,
        username,
        displayName,
        email,
        credential.hash,
        credential.salt,
        access.role,
        accessGroup,
        JSON.stringify(access.permissions),
        companyId,
        hierarchy,
        sector,
      ).run();
      const created = await readUserById(env.DB, id);
      return Response.json({ user: created ? publicUser(created) : null }, { status: 201 });
    }

    const id = String(body.id ?? "");
    if (!id || id === "env-admin") return jsonError("O ADMINISTRADOR PRINCIPAL NÃO PODE SER ALTERADO AQUI.", 400);
    const existing = await readUserById(env.DB, id);
    if (!existing) return jsonError("USUÁRIO NÃO ENCONTRADO.", 404);
    if (!actorIsSuperAdmin) {
      const isSelfEdit = existing.id === actor.id;
      const existingHadUsersManage = permissionsFromJson(existing.permissionsJson).includes("users:manage");
      // Conceder users:manage pra quem ainda não tinha é escalação — bloqueia.
      // Manter (não mudar) uma permissão que a pessoa já tinha não é.
      if (access.permissions.includes("users:manage") && !existingHadUsersManage) {
        return jsonError("SOMENTE O ADMINISTRADOR PRINCIPAL PODE CONCEDER GERENCIAMENTO DE USUÁRIOS.", 403);
      }
      // Mexer em outro admin/titular de users:manage é bloqueado — mas um
      // titular de users:manage pode sempre editar a própria conta (ex.:
      // trocar a própria senha), senão fica travado pra sempre.
      if (!isSelfEdit && (existing.role === "admin" || existingHadUsersManage)) {
        return jsonError("SOMENTE O ADMINISTRADOR PRINCIPAL PODE ALTERAR ESTE USUÁRIO.", 403);
      }
    }
    const active = body.active === false ? 0 : 1;
    if (password && (password.length < 8 || password.length > 200)) {
      return jsonError("A NOVA SENHA DEVE TER PELO MENOS 8 CARACTERES.", 400);
    }
    if (password) {
      const credential = await hashPassword(password);
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE app_users SET username=?1, display_name=?2, email=?3, role=?4,
            access_group=?5, permissions_json=?6, company_id=?7, hierarchy=?8, sector=?9, active=?10, password_hash=?11,
            password_salt=?12, session_version=session_version+1,
            updated_at=CURRENT_TIMESTAMP WHERE id=?13`,
        ).bind(
          username,
          displayName,
          email,
          access.role,
          accessGroup,
          JSON.stringify(access.permissions),
          companyId,
          hierarchy,
          sector,
          active,
          credential.hash,
          credential.salt,
          id,
        ),
        env.DB.prepare(
          `UPDATE password_reset_requests SET status='resolved', resolved_at=CURRENT_TIMESTAMP
           WHERE user_id=?1 AND status='pending'`,
        ).bind(id),
      ]);
    } else {
      await env.DB.prepare(
        `UPDATE app_users SET username=?1, display_name=?2, email=?3, role=?4,
          access_group=?5, permissions_json=?6, company_id=?7, hierarchy=?8, sector=?9, active=?10,
          session_version=session_version+1, updated_at=CURRENT_TIMESTAMP WHERE id=?11`,
      ).bind(
        username,
        displayName,
        email,
        access.role,
        accessGroup,
        JSON.stringify(access.permissions),
        companyId,
        hierarchy,
        sector,
        active,
        id,
      ).run();
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

function recifeDateTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

async function encryptBackup(payload: unknown, secret: string) {
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(JSON.stringify(payload)),
    ),
  );
  const result = new Uint8Array(iv.length + encrypted.length);
  result.set(iv);
  result.set(encrypted, iv.length);
  return result;
}

async function createAutomaticBackup(env: Env, secret: string) {
  const bucket = (env as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) return;
  const { date } = recifeDateTime();
  if (automaticBackupDate === date) return;
  const objectKey = `automatic-backups/${date}.json.aes`;
  try {
    if (await bucket.head(objectKey)) {
      automaticBackupDate = date;
      return;
    }
    const [
      sharedState,
      users,
      preferences,
      deliveries,
      resetRequests,
      missions,
      missionCompletions,
      instructions,
      capturedProducts,
      defectiveOutputs,
      supplyItems,
      supplyRequestEvents,
    ] = await Promise.all([
      env.DB.prepare(
        "SELECT state_key AS stateKey, value_json AS value, version, updated_at AS updatedAt FROM shared_state",
      ).all(),
      env.DB.prepare(
        `SELECT id, username, display_name AS displayName, email, password_hash AS passwordHash,
                password_salt AS passwordSalt, role, access_group AS accessGroup,
                permissions_json AS permissions, company_id AS companyId, hierarchy, sector,
                active, session_version AS sessionVersion,
                created_at AS createdAt, updated_at AS updatedAt
         FROM app_users`,
      ).all(),
      env.DB.prepare("SELECT * FROM user_preferences").all(),
      env.DB.prepare("SELECT * FROM purchase_delivery_records").all(),
      env.DB.prepare("SELECT * FROM password_reset_requests").all(),
      env.DB.prepare("SELECT * FROM missions").all(),
      env.DB.prepare("SELECT * FROM mission_completions").all(),
      env.DB.prepare("SELECT * FROM instructions").all(),
      env.DB.prepare("SELECT * FROM captured_products").all(),
      env.DB.prepare("SELECT * FROM defective_outputs").all(),
      env.DB.prepare("SELECT * FROM supply_items").all(),
      env.DB.prepare("SELECT * FROM supply_request_events").all(),
    ]);
    const bytes = await encryptBackup({
      app: "ESTOQUE_UNIGAMES_AUTOMATIC_BACKUP",
      version: 1,
      encryptedAt: new Date().toISOString(),
      sharedState: sharedState.results ?? [],
      users: users.results ?? [],
      preferences: preferences.results ?? [],
      purchaseDeliveries: deliveries.results ?? [],
      passwordResetRequests: resetRequests.results ?? [],
      missions: missions.results ?? [],
      missionCompletions: missionCompletions.results ?? [],
      instructions: instructions.results ?? [],
      capturedProducts: capturedProducts.results ?? [],
      defectiveOutputs: defectiveOutputs.results ?? [],
      supplyItems: supplyItems.results ?? [],
      supplyRequestEvents: supplyRequestEvents.results ?? [],
    }, secret);
    await bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        format: "AES-GCM",
        ivBytes: "12",
        createdAt: new Date().toISOString(),
      },
    });
    automaticBackupDate = date;

    const oldBackups = await bucket.list({ prefix: "automatic-backups/" });
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 35);
    const expired = oldBackups.objects
      .filter((object) => object.uploaded < cutoff)
      .map((object) => object.key);
    if (expired.length) await bucket.delete(expired);
  } catch (error) {
    console.error("Não foi possível gerar o backup automático.", error);
  }
}

// Remove do R2 (e da referência no banco) qualquer PDF de Nota de O.S.
// anexado há mais de 30 dias, para não sobrecarregar o armazenamento. A
// SOLICITAÇÃO em si nunca é apagada — só o arquivo e as colunas que
// apontam para ele, preservando o histórico de quando foi pedida e
// atendida (mesmo padrão de "só apagar o que precisa" de
// createAutomaticBackup, que limpa backups velhos sem tocar nos dados).
let osNotesPurgeDate = "";
async function purgeOldOsNotes(env: Env): Promise<void> {
  const bucket = (env as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) return;
  const { date } = recifeDateTime();
  if (osNotesPurgeDate === date) return;
  try {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 30);
    const cutoffIso = cutoff.toISOString();
    const expired = await env.DB.prepare(
      `SELECT id, r2_key AS r2Key FROM os_notes
       WHERE r2_key <> '' AND attached_at <> '' AND attached_at < ?1`,
    )
      .bind(cutoffIso)
      .all<{ id: string; r2Key: string }>();
    const rows = expired.results ?? [];
    if (rows.length) {
      await bucket.delete(rows.map((row) => row.r2Key));
      const removedAt = new Date().toISOString();
      await env.DB.batch(
        rows.map((row) =>
          env.DB.prepare(
            `UPDATE os_notes
             SET r2_key='', file_name='', size_bytes=0, file_removed_at=?1
             WHERE id=?2`,
          ).bind(removedAt, row.id),
        ),
      );
    }
    osNotesPurgeDate = date;
  } catch (error) {
    console.error("Não foi possível remover anexos vencidos de Notas de O.S.", error);
  }
}

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

async function dispatchDueTaskNotifications(env: Env) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || "";
  const subject = env.VAPID_SUBJECT?.trim() || "";
  if (!publicKey || !privateKey || !subject) return;

  const now = recifeDateTime();
  const nowMinutes =
    Number(now.time.slice(0, 2)) * 60 + Number(now.time.slice(3, 5));
  const result = await env.DB
    .prepare(
      `SELECT state_key AS stateKey, value_json AS value
       FROM shared_state
       WHERE state_key = ?1 OR state_key LIKE ?2`,
    )
    .bind(`tarefas:${now.date}`, `tarefas:%:${now.date}`)
    .all<{ stateKey: string; value: string }>();

  webPush.setVapidDetails(subject, publicKey, privateKey);
  for (const row of result.results ?? []) {
    const userId = row.stateKey === `tarefas:${now.date}`
      ? "env-admin"
      : row.stateKey.slice("tarefas:".length, -(now.date.length + 1));
    if (!userId) continue;
    let tasks: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(row.value) as { tasks?: unknown };
      tasks = Array.isArray(parsed.tasks)
        ? parsed.tasks.filter((task): task is Record<string, unknown> =>
            Boolean(task) && typeof task === "object")
        : [];
    } catch {
      continue;
    }

    for (const task of tasks) {
      if (task.done === true || typeof task.time !== "string" || typeof task.id !== "string") {
        continue;
      }
      const taskMinutes =
        Number(task.time.slice(0, 2)) * 60 + Number(task.time.slice(3, 5));
      const delay = nowMinutes - taskMinutes;
      if (!Number.isFinite(taskMinutes) || delay < 0 || delay > 4) continue;
      const scheduledFor = `${now.date}T${task.time}:00-03:00`;
      const delivered = await env.DB
        .prepare(
          `SELECT id FROM push_delivery_log
           WHERE user_id=?1 AND task_key=?2 AND task_id=?3 AND scheduled_for=?4 LIMIT 1`,
        )
        .bind(userId, row.stateKey, task.id, scheduledFor)
        .first<{ id: string }>();
      if (delivered) continue;

      const subscriptions = await env.DB
        .prepare(
          `SELECT id, endpoint, p256dh, auth
           FROM push_subscriptions WHERE user_id=?1`,
        )
        .bind(userId)
        .all<PushSubscriptionRow>();
      let sent = false;
      for (const subscription of subscriptions.results ?? []) {
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            JSON.stringify({
              title: `Tarefa agendada para ${task.time}`,
              body: typeof task.text === "string" ? task.text : "Tarefa pendente",
              url: "/tarefas",
              tag: `unigames-task-${now.date}-${task.id}`,
            }),
            { TTL: 60 * 60, urgency: "high" },
          );
          sent = true;
        } catch (error) {
          const statusCode =
            typeof error === "object" && error && "statusCode" in error
              ? Number((error as { statusCode?: unknown }).statusCode)
              : 0;
          if (statusCode === 404 || statusCode === 410) {
            await env.DB
              .prepare("DELETE FROM push_subscriptions WHERE id=?1")
              .bind(subscription.id)
              .run();
          } else {
            console.error("Falha ao enviar lembrete de tarefa.", error);
          }
        }
      }
      if (sent) {
        await env.DB
          .prepare(
            `INSERT INTO push_delivery_log
              (id, user_id, task_key, task_id, scheduled_for, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, task_key, task_id, scheduled_for) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), userId, row.stateKey, task.id, scheduledFor)
          .run();
      }
    }
  }
}

type DueMissionRow = {
  id: string;
  title: string;
  scope: string;
  companyId: string;
  dueTime: string;
};

type MissionNotificationUserRow = {
  id: string;
  role: string;
  accessGroup: string;
  permissionsJson: string;
  companyId: string;
};

function addDateDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function missionNotificationAllowed(user: MissionNotificationUserRow) {
  if (!user.companyId) return false;
  if (user.role === "admin" || user.accessGroup !== "custom") return true;
  return permissionsFromJson(user.permissionsJson).includes("missions:notify");
}

async function dispatchDueMissionNotifications(env: Env) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || "";
  const subject = env.VAPID_SUBJECT?.trim() || "";
  if (!publicKey || !privateKey || !subject) return;

  const now = recifeDateTime();
  const occurrenceDates = [now.date, addDateDays(now.date, 1)];
  const nowEpoch = Date.parse(`${now.date}T${now.time}:00-03:00`);
  webPush.setVapidDetails(subject, publicKey, privateKey);

  for (const occurrenceDate of occurrenceDates) {
    const result = await env.DB
      .prepare(
        `SELECT id, title, scope, company_id AS companyId, due_time AS dueTime
         FROM missions
         WHERE due_time <> ''
           AND start_date <= ?1
           AND (
             frequency='daily'
             OR (frequency='once' AND start_date=?1)
             OR (frequency='weekly' AND EXTRACT(DOW FROM start_date::date)=EXTRACT(DOW FROM ?1::date))
           )`,
      )
      .bind(occurrenceDate)
      .all<DueMissionRow>();

    for (const mission of result.results ?? []) {
      const dueEpoch = Date.parse(`${occurrenceDate}T${mission.dueTime}:00-03:00`);
      const remainingMinutes = Math.round((dueEpoch - nowEpoch) / 60_000);
      const reminderOffset = [120, 60].find(
        (offset) => remainingMinutes <= offset && remainingMinutes >= offset - 4,
      );
      if (!reminderOffset) continue;

      const users = await env.DB
        .prepare(
          `SELECT id, role, access_group AS accessGroup,
                  permissions_json AS permissionsJson, company_id AS companyId
           FROM app_users
           WHERE active=1 AND company_id <> ''
             AND (?1='general' OR company_id=?2)`,
        )
        .bind(mission.scope, mission.companyId)
        .all<MissionNotificationUserRow>();

      for (const user of (users.results ?? []).filter(missionNotificationAllowed)) {
        const completion = await env.DB
          .prepare(
            `SELECT id, status FROM mission_completions
             WHERE mission_id=?1 AND occurrence_date=?2 AND company_id=?3 LIMIT 1`,
          )
          .bind(mission.id, occurrenceDate, user.companyId)
          .first<{ id: string; status: string }>();
        if (completion?.status === "completed") continue;

        const scheduledFor =
          `${occurrenceDate}T${mission.dueTime}:00-03:00|${reminderOffset}`;
        const deliveryKey = `missao:${mission.id}:${occurrenceDate}`;
        const deliveryId = `${mission.id}:${reminderOffset}`;
        const delivered = await env.DB
          .prepare(
            `SELECT id FROM push_delivery_log
             WHERE user_id=?1 AND task_key=?2 AND task_id=?3 AND scheduled_for=?4 LIMIT 1`,
          )
          .bind(user.id, deliveryKey, deliveryId, scheduledFor)
          .first<{ id: string }>();
        if (delivered) continue;

        const subscriptions = await env.DB
          .prepare(
            `SELECT id, endpoint, p256dh, auth
             FROM push_subscriptions WHERE user_id=?1`,
          )
          .bind(user.id)
          .all<PushSubscriptionRow>();
        let sent = false;
        for (const subscription of subscriptions.results ?? []) {
          try {
            await webPush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              JSON.stringify({
                title:
                  reminderOffset === 120
                    ? "Missão termina em 2 horas"
                    : "Missão termina em 1 hora",
                body: mission.title,
                url: "/missoes",
                tag: `unigames-mission-${mission.id}-${occurrenceDate}-${reminderOffset}`,
              }),
              { TTL: 60 * 60, urgency: "high" },
            );
            sent = true;
          } catch (error) {
            const statusCode =
              typeof error === "object" && error && "statusCode" in error
                ? Number((error as { statusCode?: unknown }).statusCode)
                : 0;
            if (statusCode === 404 || statusCode === 410) {
              await env.DB
                .prepare("DELETE FROM push_subscriptions WHERE id=?1")
                .bind(subscription.id)
                .run();
            } else {
              console.error("Falha ao enviar lembrete de missão.", error);
            }
          }
        }
        if (sent) {
          await env.DB
            .prepare(
              `INSERT INTO push_delivery_log
                (id, user_id, task_key, task_id, scheduled_for, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
               ON CONFLICT (user_id, task_key, task_id, scheduled_for) DO NOTHING`,
            )
            .bind(
              crypto.randomUUID(),
              user.id,
              deliveryKey,
              deliveryId,
              scheduledFor,
            )
            .run();
        }
      }
    }
  }
}

type RoutineCompanyRecord = { id: string; name: string };
type DueRoutineRow = {
  id: string;
  weekdays: string;
};

function parseRoutineWeekdays(text: string): number[] {
  return text
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
}

const ROUTINE_DIACRITICS_PATTERN = new RegExp(
  "[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]",
  "g",
);

// Depósito e Assistência são setores internos, não lojas — não recebem rotinas gerais.
function isNonStoreCompany(name: string) {
  const normalized = name.toLowerCase().normalize("NFD").replace(ROUTINE_DIACRITICS_PATTERN, "").trim();
  if (/\bassistencia\b/.test(normalized) || normalized.includes("assistance")) return true;
  return (
    /\bdeposito\b/.test(normalized) ||
    normalized === "cd" ||
    normalized.startsWith("cd ") ||
    normalized.includes("centro de distribuicao")
  );
}

async function routineStoreCompanies(env: Env): Promise<RoutineCompanyRecord[]> {
  try {
    const row = await env.DB
      .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
      .first<{ value: string }>();
    const parsed = row?.value ? JSON.parse(row.value) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RoutineCompanyRecord =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        !isNonStoreCompany(item.name),
    );
  } catch {
    return [];
  }
}

// Roda a cada minuto (idempotente): migra pendências de rotina não concluídas
// para a data de hoje e gera as tarefas de hoje para as rotinas cujo dia da
// semana bate com hoje.
async function advanceOperationalRoutines(env: Env): Promise<void> {
  const today = recifeDateTime().date;

  await env.DB
    .prepare(
      `UPDATE operational_routine_tasks
       SET due_date=?1, carried_over=1, updated_at=CURRENT_TIMESTAMP
       WHERE status <> 'completed' AND due_date < ?1`,
    )
    .bind(today)
    .run();

  const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const activeRoutines = await env.DB
    .prepare(`SELECT id, weekdays FROM operational_routines WHERE active=1`)
    .all<DueRoutineRow>();
  const dueRoutineIds = (activeRoutines.results ?? [])
    .filter((routine) => parseRoutineWeekdays(routine.weekdays).includes(todayWeekday))
    .map((routine) => routine.id);
  if (!dueRoutineIds.length) return;

  const companies = await routineStoreCompanies(env);

  for (const routineId of dueRoutineIds) {
    for (const target of companies) {
      if (!target.id) continue;
      await env.DB
        .prepare(
          `INSERT INTO operational_routine_tasks
            (id, routine_id, company_id, company_name, origin_date, due_date, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'todo', CURRENT_TIMESTAMP)
           ON CONFLICT (routine_id, origin_date, company_id) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), routineId, target.id, target.name, today)
        .run();
    }
  }
}

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("x-unigames-live-company-id");
  headers.delete("x-unigames-live-capture-category");
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

// Este worker acessa `env.DB` diretamente (binding nativo do D1), ao
// contrário das rotas em app/api/*, que passam por getD1() em
// db/index.ts. Pra permitir testar este arquivo contra o Supabase com
// DB_DRIVER=postgres sem duplicar a lógica de escolha de driver,
// substituímos `env.DB` uma única vez aqui, na entrada — o resto do
// arquivo continua chamando `env.DB.prepare(...)` normalmente, sem
// mudar de forma. Usado tanto por `fetch()` quanto por `scheduled()`
// (o cron também chama `env.DB.prepare(...)` por baixo, ex.:
// dispatchDueTaskNotifications).
async function resolvePostgresBackedEnv(rawEnv: Env): Promise<Env> {
  if (process.env.DB_DRIVER !== "postgres") return rawEnv;
  return {
    ...rawEnv,
    DB: (await import("../db/d1-compat")).createD1CompatFromPg(
      await (await import("../db/pg-client")).getSql(),
    ) as unknown as D1Database,
  };
}

const worker = {
  async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    const env = await resolvePostgresBackedEnv(rawEnv);
    if (env.DB) await ensureAppUsersTable(env.DB);
    const url = new URL(request.url);

    if (url.pathname === "/login") return handleLogin(request, env, url);
    if (url.pathname === "/recuperar-senha") {
      return handlePasswordRecovery(request, env, url);
    }
    if (url.pathname === "/logout") return handleLogout(request, url);
    if (PUBLIC_ASSET_PATHS.has(url.pathname)) return env.ASSETS.fetch(request);

    const config = loginConfig(env);
    if (!config) return unauthorized(request, url);
    let user: AuthenticatedUser | null;
    try {
      user = await authenticatedUser(request, env, config);
    } catch (error) {
      if (!(error instanceof SessionLookupError)) throw error;
      return serviceUnavailable(url);
    }
    if (!user) return unauthorized(request, url);
    const mutatingApiRequest =
      url.pathname.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutatingApiRequest && !sameOrigin(request, url)) {
      return securityHeaders(
        jsonError("ORIGEM DA SOLICITAÇÃO NÃO PERMITIDA.", 403),
      );
    }
    if (!(await isAllowed(request, url, user))) return forbidden(url);
    if (url.pathname === "/api/session") return sessionResponse(user);
    if (url.pathname === "/api/admin/users") {
      return securityHeaders(await handleAdminUsers(request, env, url, config, user));
    }
    if (url.pathname === "/api/live") {
      const liveModuleName = url.searchParams.get("module");
      if (!isLiveModule(liveModuleName)) return jsonError("MODULO AO VIVO INVALIDO.", 400);
      if (!sameOrigin(request, url)) return jsonError("ORIGEM NAO PERMITIDA.", 403);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", {
          status: 426,
          headers: { "cache-control": "no-store" },
        });
      }
      return connectLiveUpdates(request, env, user, liveModuleName);
    }

    const authenticatedHeaders = new Headers(request.headers);
    authenticatedHeaders.delete(USER_ID_HEADER);
    authenticatedHeaders.delete(USERNAME_HEADER);
    authenticatedHeaders.delete(DISPLAY_NAME_HEADER);
    authenticatedHeaders.delete(ROLE_HEADER);
    authenticatedHeaders.delete(ACCESS_GROUP_HEADER);
    authenticatedHeaders.delete(PERMISSIONS_HEADER);
    authenticatedHeaders.delete(COMPANY_ID_HEADER);
    authenticatedHeaders.delete(SECTOR_HEADER);
    authenticatedHeaders.set(INTERNAL_AUTH_HEADER, "1");
    authenticatedHeaders.set(USER_ID_HEADER, user.id);
    authenticatedHeaders.set(USERNAME_HEADER, user.username);
    authenticatedHeaders.set(DISPLAY_NAME_HEADER, encodeURIComponent(user.displayName));
    authenticatedHeaders.set(ROLE_HEADER, user.role);
    authenticatedHeaders.set(ACCESS_GROUP_HEADER, user.accessGroup);
    authenticatedHeaders.set(PERMISSIONS_HEADER, user.permissions.join(","));
    authenticatedHeaders.set(COMPANY_ID_HEADER, user.companyId);
    authenticatedHeaders.set(SECTOR_HEADER, user.sector);
    const authenticatedRequest = new Request(request, {
      headers: authenticatedHeaders,
    });

    const normalizedPath =
      url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    if (
      normalizedPath === "/" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return Response.redirect(new URL(LOGIN_SUCCESS_PATH, url.origin), 302);
    }
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
      const appResponse = securityHeaders(await env.ASSETS.fetch(appAssetRequest));
      // estoque.html is a static, unpersonalized shell (session/permission data
      // loads client-side via /api/session), so it's safe to let the browser
      // cache it briefly instead of re-downloading the ~500KB file on every
      // navigation between pages.
      const appHeaders = new Headers(appResponse.headers);
      appHeaders.set("cache-control", "private, max-age=300, must-revalidate");
      return new Response(appResponse.body, {
        status: appResponse.status,
        statusText: appResponse.statusText,
        headers: appHeaders,
      });
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

    const requestInvalidation = await liveInvalidationForRequest(authenticatedRequest, user);
    const response = await handler.fetch(authenticatedRequest, env, ctx);
    const liveInvalidation = liveInvalidationForResponse(
      authenticatedRequest,
      response,
      requestInvalidation,
    );
    if (response.ok && liveInvalidation) {
      ctx.waitUntil(publishLiveUpdate(env, liveInvalidation));
    }
    return securityHeaders(response);
  },
  async scheduled(
    _controller: ScheduledController,
    rawEnv: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const config = loginConfig(rawEnv);
    if (!config) return;
    const env = await resolvePostgresBackedEnv(rawEnv);
    ctx.waitUntil(Promise.all([
      dispatchDueTaskNotifications(env),
      dispatchDueMissionNotifications(env),
      advanceOperationalRoutines(env),
      createAutomaticBackup(env, config.sessionSecret),
      purgeOldOsNotes(env),
    ]));
  },
};

export default worker;
