import webPush from "web-push";
import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;
type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

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
    if (payload.action === "test") {
      const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || "";
      const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || "";
      const subject = process.env.VAPID_SUBJECT?.trim() || "";
      if (!publicKey || !privateKey || !subject) {
        return jsonResponse({ error: "NOTIFICAÇÕES AINDA NÃO CONFIGURADAS." }, 503);
      }
      const database = await getD1();
      const subscriptions = await database
        .prepare(
          `SELECT id, endpoint, p256dh, auth
           FROM push_subscriptions WHERE user_id=?1`,
        )
        .bind(id)
        .all<PushSubscriptionRow>();
      if (!(subscriptions.results ?? []).length) {
        return jsonResponse(
          { error: "ESTE APARELHO AINDA NÃO ESTÁ INSCRITO. CONCLUA A ATIVAÇÃO PRIMEIRO." },
          409,
        );
      }

      webPush.setVapidDetails(subject, publicKey, privateKey);
      let sent = 0;
      for (const subscription of subscriptions.results ?? []) {
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            JSON.stringify({
              title: "Notificações Unigames ativadas",
              body: "Este aparelho está pronto para receber lembretes de tarefas e missões.",
              url: "/missoes",
              tag: `unigames-push-test-${id}`,
            }),
            { TTL: 60 * 10, urgency: "high" },
          );
          sent += 1;
        } catch (error) {
          const statusCode =
            typeof error === "object" && error && "statusCode" in error
              ? Number((error as { statusCode?: unknown }).statusCode)
              : 0;
          if (statusCode === 404 || statusCode === 410) {
            await database
              .prepare("DELETE FROM push_subscriptions WHERE id=?1")
              .bind(subscription.id)
              .run();
          } else {
            console.error("Falha ao enviar notificação de teste.", error);
          }
        }
      }
      if (!sent) {
        return jsonResponse(
          { error: "A INSCRIÇÃO DESTE APARELHO EXPIROU. ATIVE AS NOTIFICAÇÕES NOVAMENTE." },
          410,
        );
      }
      return jsonResponse({ sent: true, count: sent });
    }

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
