import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function userId(request: Request) {
  return (request.headers.get("x-unigames-user-id") || "").trim();
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || "";
  if (!publicKey) {
    return jsonResponse({ error: "NOTIFICAÇÕES AINDA NÃO CONFIGURADAS." }, 503);
  }
  return jsonResponse({ publicKey });
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const id = userId(request);
  if (!id) return jsonResponse({ error: "USUÁRIO NÃO IDENTIFICADO." }, 401);

  try {
    const payload = (await request.json()) as JsonMap;
    const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
    const keys = payload.keys && typeof payload.keys === "object"
      ? (payload.keys as JsonMap)
      : {};
    const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
    const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";
    if (
      !/^https:\/\//i.test(endpoint) ||
      endpoint.length > 2000 ||
      !p256dh ||
      !auth
    ) {
      return jsonResponse({ error: "INSCRIÇÃO DE NOTIFICAÇÃO INVÁLIDA." }, 400);
    }
    const database = await getD1();
    await database
      .prepare(
        `INSERT INTO push_subscriptions
          (id, user_id, endpoint, p256dh, auth, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(crypto.randomUUID(), id, endpoint, p256dh, auth)
      .run();
    return jsonResponse({ subscribed: true });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATIVAR AS NOTIFICAÇÕES." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const id = userId(request);
  const endpoint = new URL(request.url).searchParams.get("endpoint") || "";
  if (!id || !endpoint) return jsonResponse({ error: "INSCRIÇÃO INVÁLIDA." }, 400);
  try {
    const database = await getD1();
    await database
      .prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2")
      .bind(id, endpoint)
      .run();
    return jsonResponse({ deleted: true });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL DESATIVAR AS NOTIFICAÇÕES." }, 500);
  }
}
