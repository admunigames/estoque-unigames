import { getD1 } from "../../../../../db";
import { acceptWatched, videoCompleted } from "../../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../../lib/notion";
import { identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { employeeOfUser, finishTrailIfComplete, loadVideos } from "../shared";

// Batida do player (a cada ~10 s e ao pausar/terminar): o colaborador informa
// até onde assistiu SEM PULAR e onde parou. O servidor só aceita o avanço que
// cabe no tempo real decorrido (acceptWatched) — adiantar não conta.
// Fora da Auditoria de propósito (app/lib/audit.ts): é só telemetria do player.

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const actor = identity(request);
  try {
    const body = (await request.json()) as JsonMap;
    const videoId = safeText(body.videoId, 80);
    const reported = Math.max(0, Number(body.watchedSeconds) || 0);
    const position = Math.max(0, Number(body.positionSeconds) || 0);
    const database = await getD1();
    const employee = await employeeOfUser(database, actor.id);
    if (!employee) return jsonResponse({ error: "VOCÊ NÃO TEM TRILHA DE ONBOARDING." }, 403);
    const video = (await loadVideos(database, true)).find((item) => item.id === videoId);
    if (!video) return jsonResponse({ error: "VÍDEO NÃO ENCONTRADO." }, 404);

    const existing = await database
      .prepare(
        `SELECT id, watched_seconds AS watchedSeconds, completed_at AS completedAt, updated_at AS updatedAt
         FROM hr_onboarding_progress WHERE employee_id=?1 AND video_id=?2`,
      )
      .bind(employee.id, videoId)
      .first<{ id: string; watchedSeconds: number; completedAt: string; updatedAt: string }>();
    const now = new Date();
    const elapsed = existing ? (now.getTime() - Date.parse(existing.updatedAt || now.toISOString())) / 1000 : 0;
    const watched = acceptWatched(Number(existing?.watchedSeconds || 0), reported, elapsed, video.durationSeconds);
    const done = existing?.completedAt || (videoCompleted(watched, video.durationSeconds) ? now.toISOString() : "");
    const positionSeconds = Math.min(Math.floor(position), video.durationSeconds || Math.floor(position));
    if (existing) {
      await database
        .prepare("UPDATE hr_onboarding_progress SET watched_seconds=?1, position_seconds=?2, completed_at=?3, updated_at=?4 WHERE id=?5")
        .bind(watched, positionSeconds, done, now.toISOString(), existing.id)
        .run();
    } else {
      await database
        .prepare(
          `INSERT INTO hr_onboarding_progress (id, employee_id, video_id, watched_seconds, position_seconds, completed_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (employee_id, video_id) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), employee.id, videoId, watched, positionSeconds, done, now.toISOString())
        .run();
    }
    if (done && !existing?.completedAt) {
      await finishTrailIfComplete(database, employee)
        .catch((error) => console.error("Não foi possível concluir a trilha de onboarding.", error));
    }
    return jsonResponse({ watchedSeconds: watched, completed: Boolean(done) });
  } catch (error) {
    console.error("Não foi possível registrar o progresso do vídeo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O PROGRESSO DO VÍDEO." }, 500);
  }
}
