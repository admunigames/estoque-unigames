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

const SESSION_COOKIE = "unigames_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const INTERNAL_AUTH_HEADER = "x-unigames-authenticated";
const PUBLIC_ASSET_PATHS = new Set(["/favicon.svg", "/og.png"]);
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function createSession(username: string, secret: string): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        sub: username,
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

async function hasValidSession(request: Request, config: LoginConfig): Promise<boolean> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;

  try {
    const expected = await hmac(payload, config.sessionSecret);
    if (!constantTimeEqual(signature, expected)) return false;
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as {
      sub?: unknown;
      exp?: unknown;
    };
    return (
      parsed.sub === config.username &&
      typeof parsed.exp === "number" &&
      parsed.exp > Date.now()
    );
  } catch {
    return false;
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
  const next = safeNext(url.searchParams.get("next"));
  if (!config) {
    return loginPage({
      next,
      status: 503,
      message: "O acesso ainda não foi configurado pela administração.",
      configured: false,
    });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (await hasValidSession(request, config)) {
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
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const formNext = safeNext(String(form.get("next") ?? next));
  if (
    !constantTimeEqual(username, config.username) ||
    !constantTimeEqual(password, config.password)
  ) {
    recordFailure(request);
    return loginPage({
      next: formNext,
      status: 401,
      message: "Usuário ou senha inválidos.",
      configured: true,
    });
  }

  clearFailures(request);
  const token = await createSession(config.username, config.sessionSecret);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: formNext,
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
    if (!config || !(await hasValidSession(request, config))) {
      return unauthorized(request, url);
    }

    const authenticatedHeaders = new Headers(request.headers);
    authenticatedHeaders.set(INTERNAL_AUTH_HEADER, "1");
    const authenticatedRequest = new Request(request, {
      headers: authenticatedHeaders,
    });

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
