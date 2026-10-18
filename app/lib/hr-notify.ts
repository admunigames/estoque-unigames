import webPush from "web-push";
import { upperText } from "./upper-text";

// Aviso do RH = push (quando o login tem inscrição) + tarefa na lista do dia
// (shared_state "tarefas:<usuário>:<data>", a mesma das Tarefas/Início).
// Usado pelas rotas (Recrutamento, PDI, Onboarding) e pelo cron do Worker
// (vencimento de exames, aniversário na véspera).

type Db = Pick<D1Database, "prepare">;

export type Vapid = { publicKey: string; privateKey: string; subject: string };

export function vapidFromEnv(source: Record<string, string | undefined>): Vapid | null {
  const publicKey = source.VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = source.VAPID_PRIVATE_KEY?.trim() || "";
  const subject = source.VAPID_SUBJECT?.trim() || "";
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

/** Logins ativos com alguma das permissões (ou admin) + a conta principal. */
export async function usersWithPermission(db: Db, permissions: string[]): Promise<string[]> {
  const likes = permissions.map((_, index) => `permissions_json LIKE ?${index + 1}`).join(" OR ");
  const result = await db
    .prepare(`SELECT id FROM app_users WHERE active=1 AND (role='admin'${likes ? ` OR ${likes}` : ""})`)
    .bind(...permissions.map((permission) => `%"${permission}"%`))
    .all<{ id: string }>();
  return [...new Set(["env-admin", ...(result.results ?? []).map((row) => row.id)])];
}

export type TaskInput = { id: string; text: string; time?: string; priority?: "low" | "medium" | "high" | "urgent" };

/** Põe (ou atualiza) a tarefa `task.id` no dia do usuário. Idempotente. */
export async function upsertUserTask(db: Db, userId: string, date: string, task: TaskInput): Promise<void> {
  const key = `tarefas:${userId}:${date}`;
  const text = upperText(task.text).slice(0, 500);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .prepare("SELECT value_json AS value, version FROM shared_state WHERE state_key=?1")
      .bind(key)
      .first<{ value: string; version: number }>();
    let data: { tasks?: Array<Record<string, unknown>>; notes?: string } = {};
    try {
      data = row ? JSON.parse(row.value) : {};
    } catch {
      data = {};
    }
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const existing = tasks.find((item) => item && item.id === task.id);
    if (existing && existing.text === text && (existing.time || "") === (task.time || "")) return;
    if (existing) {
      existing.text = text;
      existing.time = task.time || "";
    } else {
      tasks.push({
        id: task.id, time: task.time || "", text, done: false, outcome: "not_seen", carriedFrom: "",
        priority: task.priority || "high", recurrence: "none", seriesId: task.id,
      });
    }
    const value = JSON.stringify({ ...data, tasks, notes: typeof data.notes === "string" ? data.notes : "" });
    const now = new Date().toISOString();
    if (row) {
      // Só grava se ninguém mexeu no dia entre a leitura e a escrita.
      await db
        .prepare("UPDATE shared_state SET value_json=?1, version=version+1, updated_at=?2 WHERE state_key=?3 AND version=?4")
        .bind(value, now, key, row.version)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO shared_state (state_key, value_json, version, updated_at)
           VALUES (?1, ?2, 1, ?3) ON CONFLICT (state_key) DO NOTHING`,
        )
        .bind(key, value, now)
        .run();
    }
    const check = await db.prepare("SELECT value_json AS value FROM shared_state WHERE state_key=?1").bind(key).first<{ value: string }>();
    if (check && check.value.includes(JSON.stringify(task.id))) return;
  }
}

export type PushInput = { title: string; body: string; url: string; tag: string };

/** Push para todas as inscrições dos logins; remove inscrição expirada. */
export async function pushToUsers(db: Db, vapid: Vapid | null, userIds: string[], payload: PushInput) {
  if (!vapid || !userIds.length) return;
  webPush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  for (const userId of userIds) {
    const subscriptions = await db
      .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?1")
      .bind(userId)
      .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
    for (const subscription of subscriptions.results ?? []) {
      try {
        await webPush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify({ ...payload, title: upperText(payload.title), body: upperText(payload.body) }),
          { TTL: 60 * 60 * 12, urgency: "high" },
        );
      } catch (error) {
        const statusCode = typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : 0;
        if (statusCode === 404 || statusCode === 410) {
          await db.prepare("DELETE FROM push_subscriptions WHERE id=?1").bind(subscription.id).run();
        } else {
          console.error("Falha ao enviar aviso do RH.", error);
        }
      }
    }
  }
}

/**
 * Aviso completo (push + tarefa). Com `onceKey`, cada login recebe uma vez só
 * (push_delivery_log) — usado pelo cron, que roda a cada minuto.
 */
export async function notifyUsers(
  db: Db,
  vapid: Vapid | null,
  userIds: string[],
  notice: { push: PushInput; task?: TaskInput & { date: string }; onceKey?: { key: string; id: string; scheduledFor: string } },
) {
  for (const userId of [...new Set(userIds.filter(Boolean))]) {
    const once = notice.onceKey;
    if (once) {
      const delivered = await db
        .prepare(
          `SELECT id FROM push_delivery_log
           WHERE user_id=?1 AND task_key=?2 AND task_id=?3 AND scheduled_for=?4 LIMIT 1`,
        )
        .bind(userId, once.key, once.id, once.scheduledFor)
        .first<{ id: string }>();
      if (delivered) continue;
    }
    try {
      if (notice.task) await upsertUserTask(db, userId, notice.task.date, notice.task);
      await pushToUsers(db, vapid, [userId], notice.push);
    } catch (error) {
      console.error("Falha ao registrar aviso do RH.", error);
      continue;
    }
    if (once) {
      await db
        .prepare(
          `INSERT INTO push_delivery_log (id, user_id, task_key, task_id, scheduled_for, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, task_key, task_id, scheduled_for) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), userId, once.key, once.id, once.scheduledFor)
        .run();
    }
  }
}
