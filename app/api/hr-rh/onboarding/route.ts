import { getD1 } from "../../../../db";
import { DATE_RE } from "../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import { actorName, identity, jsonResponse, rhCan, safeText, sameOrigin, type JsonMap } from "../shared";
import {
  TRAIL_EMPLOYEE_COLUMNS,
  employeeOfUser,
  loadProgress,
  loadVideos,
  trailOf,
  type TrailEmployee,
} from "./shared";

// GET ?scope=my     — trilha do próprio login (qualquer usuário com cadastro no RH)
// GET ?scope=videos — vídeos cadastrados (rh_onboarding:videos ou :track)
// GET ?scope=track  — painel do RH: % assistido por pessoa (rh_onboarding:track)
// POST action=video   — cadastra/edita vídeo (o arquivo vai pela rota /upload)
// POST action=start   — inclui um funcionário já cadastrado na trilha
// POST action=meeting — registra a reunião de onboarding (dúvidas sobre os vídeos)

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const scope = new URL(request.url).searchParams.get("scope") || "my";
  try {
    const database = await getD1();
    if (scope === "my") {
      const employee = await employeeOfUser(database, actor.id);
      if (!employee) return jsonResponse({ employee: null, videos: [], percent: 0, completed: false });
      const trail = trailOf(employee, await loadVideos(database, true), await loadProgress(database, employee.id));
      return jsonResponse({ employee: { id: employee.id, fullName: employee.fullName, companyName: employee.companyName }, ...trail });
    }
    if (scope === "videos") {
      if (!rhCan(actor, "rh_onboarding:videos", "rh_onboarding:track")) {
        return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER OS VÍDEOS DE ONBOARDING." }, 403);
      }
      return jsonResponse({ videos: await loadVideos(database, false) });
    }
    if (scope === "track") {
      if (!rhCan(actor, "rh_onboarding:track")) {
        return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACOMPANHAR O ONBOARDING." }, 403);
      }
      const employees = await database
        .prepare(`SELECT ${TRAIL_EMPLOYEE_COLUMNS}, admission_date AS admissionDate FROM hr_employees
          WHERE status='active' ORDER BY full_name ASC`)
        .all<TrailEmployee & { admissionDate: string }>();
      const videos = await loadVideos(database, true);
      const progress = await loadProgress(database);
      const people = (employees.results ?? []).map((employee) => {
        const trail = employee.onboardingStartedAt ? trailOf(employee, videos, progress) : null;
        return {
          id: employee.id, fullName: employee.fullName, companyName: employee.companyName, roleTitle: employee.roleTitle,
          admissionDate: employee.admissionDate, hasLogin: Boolean(employee.userId), inTrail: Boolean(employee.onboardingStartedAt),
          startedAt: employee.onboardingStartedAt, completedAt: employee.onboardingCompletedAt,
          meetingDate: employee.onboardingMeetingDate, meetingNotes: employee.onboardingMeetingNotes,
          meetingByName: employee.onboardingMeetingByName,
          videos: trail ? trail.videos.length : 0,
          videosDone: trail ? trail.videos.filter((video) => video.completed).length : 0,
          percent: trail ? trail.percent : 0,
        };
      });
      return jsonResponse({ people });
    }
    return jsonResponse({ error: "CONSULTA INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível carregar o onboarding.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O ONBOARDING." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    const database = await getD1();
    const now = new Date().toISOString();

    if (action === "video") {
      if (!rhCan(actor, "rh_onboarding:videos")) {
        return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR VÍDEOS." }, 403);
      }
      const id = safeText(body.id, 80);
      const title = safeText(body.title, 160);
      if (!title) return jsonResponse({ error: "INFORME O TÍTULO DO VÍDEO." }, 400);
      const companyId = safeText(body.companyId, 80);
      let companyName = "";
      if (companyId) {
        const company = (await loadCompanyList(database)).find((item) => item.id === companyId);
        if (!company) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
        companyName = company.name;
      }
      const values = [
        title,
        safeText(body.description, 2000),
        Math.max(0, Math.min(9999, Math.round(Number(body.sortOrder) || 0))),
        safeText(body.roleTitle, 120),
        companyId,
        companyName,
        body.active === false || body.active === 0 ? 0 : 1,
        actor.id,
        actorName(actor),
        now,
      ];
      if (id) {
        const existing = await database.prepare("SELECT id FROM hr_onboarding_videos WHERE id=?1").bind(id).first<{ id: string }>();
        if (!existing) return jsonResponse({ error: "VÍDEO NÃO ENCONTRADO." }, 404);
        await database
          .prepare(
            `UPDATE hr_onboarding_videos SET title=?1, description=?2, sort_order=?3, role_title=?4, company_id=?5,
               company_name=?6, active=?7, updated_by=?8, updated_by_name=?9, updated_at=?10 WHERE id=?11`,
          )
          .bind(...values, id)
          .run();
        return jsonResponse({ updated: true, id });
      }
      const newId = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO hr_onboarding_videos (title, description, sort_order, role_title, company_id, company_name, active,
             updated_by, updated_by_name, updated_at, id, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?8, ?9, ?10)`,
        )
        .bind(...values, newId)
        .run();
      return jsonResponse({ created: true, id: newId }, 201);
    }

    if (action === "start" || action === "meeting") {
      if (!rhCan(actor, "rh_onboarding:track")) {
        return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACOMPANHAR O ONBOARDING." }, 403);
      }
      const employeeId = safeText(body.employeeId, 80);
      const employee = await database
        .prepare("SELECT id, onboarding_started_at AS startedAt FROM hr_employees WHERE id=?1")
        .bind(employeeId)
        .first<{ id: string; startedAt: string }>();
      if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
      if (action === "start") {
        await database
          .prepare("UPDATE hr_employees SET onboarding_started_at=?1 WHERE id=?2 AND onboarding_started_at=''")
          .bind(now, employeeId)
          .run();
        return jsonResponse({ started: true });
      }
      const meetingDate = safeText(body.meetingDate, 10);
      const notes = safeText(body.notes, 4000);
      if (!DATE_RE.test(meetingDate)) return jsonResponse({ error: "INFORME A DATA DA REUNIÃO." }, 400);
      if (!notes) return jsonResponse({ error: "PREENCHA AS DÚVIDAS E PERGUNTAS SOBRE O VÍDEO." }, 400);
      await database
        .prepare(
          `UPDATE hr_employees SET onboarding_meeting_date=?1, onboarding_meeting_notes=?2,
             onboarding_meeting_by_name=?3, updated_by=?4, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
        )
        .bind(meetingDate, notes, actorName(actor), actor.id, employeeId)
        .run();
      return jsonResponse({ saved: true });
    }

    return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível salvar o onboarding.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O ONBOARDING." }, 500);
  }
}
