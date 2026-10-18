import { getD1 } from "../../../../db";
import { roleFromTitle } from "../../../lib/commercial";
import { notifyUsers, usersWithPermission, vapidFromEnv } from "../../../lib/hr-notify";
import { recifeToday, videoAppliesTo, videoCompleted } from "../../../lib/hr-rh";

// RH > Onboarding — trilha de vídeos por cargo/loja. O colaborador (login
// vinculado ao cadastro do RH) assiste à própria trilha; o vídeo só conclui
// assistido até o fim (ver acceptWatched em app/lib/hr-rh.ts). Concluída a
// trilha, sai a tarefa da REUNIÃO DE ONBOARDING para RH/líder.

export type Database = Awaited<ReturnType<typeof getD1>>;

export type VideoRow = {
  id: string; title: string; description: string; sortOrder: number; roleTitle: string;
  companyId: string; companyName: string; fileName: string; contentType: string;
  sizeBytes: number; durationSeconds: number; active: number; updatedAt: string; updatedByName: string;
};

export const VIDEO_COLUMNS = `id, title, description, sort_order AS sortOrder, role_title AS roleTitle,
  company_id AS companyId, company_name AS companyName, file_name AS fileName, content_type AS contentType,
  size_bytes AS sizeBytes, duration_seconds AS durationSeconds, active, updated_at AS updatedAt,
  updated_by_name AS updatedByName`;

export type TrailEmployee = {
  id: string; fullName: string; companyId: string; companyName: string; roleTitle: string; userId: string;
  onboardingStartedAt: string; onboardingCompletedAt: string; onboardingMeetingDate: string;
  onboardingMeetingNotes: string; onboardingMeetingByName: string;
};

export const TRAIL_EMPLOYEE_COLUMNS = `id, full_name AS fullName, company_id AS companyId, company_name AS companyName,
  role_title AS roleTitle, user_id AS userId, onboarding_started_at AS onboardingStartedAt,
  onboarding_completed_at AS onboardingCompletedAt, onboarding_meeting_date AS onboardingMeetingDate,
  onboarding_meeting_notes AS onboardingMeetingNotes, onboarding_meeting_by_name AS onboardingMeetingByName`;

export type ProgressRow = {
  employeeId: string; videoId: string; watchedSeconds: number; positionSeconds: number; completedAt: string; updatedAt: string;
};

export async function loadVideos(database: Database, onlyActive: boolean) {
  const result = await database
    .prepare(`SELECT ${VIDEO_COLUMNS} FROM hr_onboarding_videos ${onlyActive ? "WHERE active=1 AND r2_key<>''" : ""}
      ORDER BY sort_order ASC, title ASC`)
    .all<VideoRow>();
  return result.results ?? [];
}

/** Cadastro do RH ativo, com trilha aberta, vinculado ao login. */
export async function employeeOfUser(database: Database, userId: string) {
  if (!userId) return null;
  return await database
    .prepare(`SELECT ${TRAIL_EMPLOYEE_COLUMNS} FROM hr_employees
      WHERE user_id=?1 AND status='active' AND onboarding_started_at<>'' LIMIT 1`)
    .bind(userId)
    .first<TrailEmployee>();
}

export async function loadProgress(database: Database, employeeId?: string) {
  const statement = database.prepare(
    `SELECT employee_id AS employeeId, video_id AS videoId, watched_seconds AS watchedSeconds,
            position_seconds AS positionSeconds, completed_at AS completedAt, updated_at AS updatedAt
     FROM hr_onboarding_progress${employeeId ? " WHERE employee_id=?1" : ""}`,
  );
  const result = await (employeeId ? statement.bind(employeeId) : statement).all<ProgressRow>();
  return result.results ?? [];
}

/** Vídeos da trilha do colaborador com o progresso de cada um e o % geral. */
export function trailOf(employee: TrailEmployee, videos: VideoRow[], progress: ProgressRow[]) {
  const items = videos
    .filter((video) => videoAppliesTo(video, employee))
    .map((video) => {
      const row = progress.find((item) => item.employeeId === employee.id && item.videoId === video.id);
      const watchedSeconds = Number(row?.watchedSeconds || 0);
      return {
        id: video.id, title: video.title, description: video.description, durationSeconds: video.durationSeconds,
        watchedSeconds, positionSeconds: Number(row?.positionSeconds || 0),
        completed: Boolean(row?.completedAt) || videoCompleted(watchedSeconds, video.durationSeconds),
      };
    });
  const total = items.reduce((sum, item) => sum + Math.max(1, item.durationSeconds), 0);
  const watched = items.reduce((sum, item) => sum + (item.completed ? Math.max(1, item.durationSeconds) : Math.min(item.watchedSeconds, item.durationSeconds)), 0);
  return {
    videos: items,
    percent: items.length ? Math.round((watched / total) * 100) : 0,
    completed: items.length > 0 && items.every((item) => item.completed),
  };
}

/** Trilha recém-concluída: marca a data e cria a tarefa da reunião (RH + líder da loja). */
export async function finishTrailIfComplete(database: Database, employee: TrailEmployee) {
  if (employee.onboardingCompletedAt) return;
  const trail = trailOf(employee, await loadVideos(database, true), await loadProgress(database, employee.id));
  if (!trail.completed) return;
  await database
    .prepare("UPDATE hr_employees SET onboarding_completed_at=?1 WHERE id=?2 AND onboarding_completed_at=''")
    .bind(new Date().toISOString(), employee.id)
    .run();
  const hr = await usersWithPermission(database, ["rh_onboarding:track"]);
  const leaders = employee.companyId
    ? ((await database
        .prepare("SELECT user_id AS userId, role_title AS roleTitle FROM hr_employees WHERE status='active' AND company_id=?1 AND user_id<>'' AND id<>?2")
        .bind(employee.companyId, employee.id)
        .all<{ userId: string; roleTitle: string }>()).results ?? [])
        .filter((row) => roleFromTitle(row.roleTitle) === "lider")
        .map((row) => row.userId)
    : [];
  const who = [employee.fullName, employee.companyName].filter(Boolean).join(" — ");
  await notifyUsers(database, vapidFromEnv(process.env), [...hr, ...leaders], {
    push: { title: "ONBOARDING CONCLUÍDO", body: `REUNIÃO DE ONBOARDING — ${who}`, url: "/rh/onboarding", tag: `unigames-onboarding-${employee.id}` },
    task: {
      date: recifeToday(),
      id: `onboarding-${employee.id}`,
      text: `REUNIÃO DE ONBOARDING — ${who}: REGISTRAR AS DÚVIDAS E PERGUNTAS SOBRE OS VÍDEOS (RH > ONBOARDING)`,
    },
  });
}
