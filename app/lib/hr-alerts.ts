import { notifyUsers, usersWithPermission, type Vapid } from "./hr-notify";
import {
  ADMISSION_CHECKLIST, ADMISSION_REMINDER_DAYS, addDays, admissionPending, asoExpiry, daysBetween, EXAM_ALERT_OFFSETS, examSituation,
  isBirthdayOn, type ExamSituation,
} from "./hr-rh";
import { roleFromTitle } from "./commercial";

// Avisos automáticos do RH disparados pelo cron do Worker (1x por dia, às
// 08:00 de Recife): vencimento do ASO (30, 7 dias e no dia — só ativos) e
// aniversário na véspera (RH + líder da loja).

type Db = Pick<D1Database, "prepare">;

export type ExamStatusRow = {
  employeeId: string;
  fullName: string;
  companyId: string;
  companyName: string;
  roleTitle: string;
  examDate: string;
  examType: string;
  expiryDate: string;
  situation: ExamSituation;
  daysLeft: number | null;
};

/** Último exame de cada funcionário ATIVO (ASO lançado ou admissional do Recrutamento). */
export async function loadExamStatus(db: Db, today: string): Promise<ExamStatusRow[]> {
  const employees = await db
    .prepare(
      `SELECT id, full_name AS fullName, company_id AS companyId, company_name AS companyName, role_title AS roleTitle
       FROM hr_employees WHERE status='active' ORDER BY company_name ASC, full_name ASC`,
    )
    .all<{ id: string; fullName: string; companyId: string; companyName: string; roleTitle: string }>();
  const exams = await db
    .prepare(
      `SELECT employee_id AS employeeId, exam_date AS examDate, exam_type AS examType, expiry_date AS expiryDate
       FROM hr_aso_exams WHERE exam_type<>'demissional'`,
    )
    .all<{ employeeId: string; examDate: string; examType: string; expiryDate: string }>();
  const admissional = await db
    .prepare(
      `SELECT hr_employee_id AS employeeId, aso_date AS examDate FROM hr_recruitment_candidates
       WHERE hr_employee_id<>'' AND aso_date<>''`,
    )
    .all<{ employeeId: string; examDate: string }>();
  const latest = new Map<string, { examDate: string; examType: string; expiryDate: string }>();
  const consider = (employeeId: string, exam: { examDate: string; examType: string; expiryDate: string }) => {
    const current = latest.get(employeeId);
    if (!current || exam.examDate > current.examDate) latest.set(employeeId, exam);
  };
  for (const exam of exams.results ?? []) consider(exam.employeeId, { ...exam, expiryDate: asoExpiry(exam.examDate, exam.expiryDate) });
  for (const exam of admissional.results ?? []) {
    consider(exam.employeeId, { examDate: exam.examDate, examType: "admissional", expiryDate: asoExpiry(exam.examDate) });
  }
  return (employees.results ?? []).map((employee) => {
    const exam = latest.get(employee.id);
    const expiryDate = exam?.expiryDate || "";
    return {
      employeeId: employee.id,
      fullName: employee.fullName,
      companyId: employee.companyId,
      companyName: employee.companyName,
      roleTitle: employee.roleTitle,
      examDate: exam?.examDate || "",
      examType: exam?.examType || "",
      expiryDate,
      situation: examSituation(expiryDate, today),
      daysLeft: expiryDate ? daysBetween(today, expiryDate) : null,
    };
  });
}

function formatDate(date: string) {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

export async function dispatchExamAlerts(db: Db, vapid: Vapid | null, today: string) {
  const due = (await loadExamStatus(db, today)).filter((row) =>
    row.expiryDate && EXAM_ALERT_OFFSETS.includes(row.daysLeft ?? -1));
  if (!due.length) return;
  const recipients = await usersWithPermission(db, ["rh_exames:view", "payroll:manage"]);
  for (const row of due) {
    const when = row.daysLeft === 0 ? "VENCE HOJE" : `VENCE EM ${row.daysLeft} DIAS (${formatDate(row.expiryDate)})`;
    const text = `EXAME ASO ${when} — ${row.fullName}${row.companyName ? ` — ${row.companyName}` : ""}`;
    await notifyUsers(db, vapid, recipients, {
      push: { title: "SEGURANÇA DO TRABALHO", body: text, url: "/rh/painel", tag: `unigames-aso-${row.employeeId}-${row.daysLeft}` },
      task: { date: today, id: `aso-${row.employeeId}-${row.expiryDate}-${row.daysLeft}`, text },
      onceKey: { key: `aso:${row.employeeId}`, id: String(row.daysLeft), scheduledFor: row.expiryDate },
    });
  }
}

export async function dispatchBirthdayEve(db: Db, vapid: Vapid | null, today: string) {
  const tomorrow = addDays(today, 1);
  const employees = await db
    .prepare(
      `SELECT id, full_name AS fullName, company_id AS companyId, company_name AS companyName,
              birth_date AS birthDate, role_title AS roleTitle, user_id AS userId
       FROM hr_employees WHERE status='active'`,
    )
    .all<{ id: string; fullName: string; companyId: string; companyName: string; birthDate: string; roleTitle: string; userId: string }>();
  const all = employees.results ?? [];
  const birthdays = all.filter((employee) => isBirthdayOn(employee.birthDate, tomorrow));
  if (!birthdays.length) return;
  const hr = await usersWithPermission(db, ["rh_aniversariantes:view", "rh_aniversariantes:manage"]);
  for (const employee of birthdays) {
    // Líder da loja = funcionário ativo da mesma loja com cargo de LÍDER e login vinculado.
    const leaders = all
      .filter((other) => other.companyId && other.companyId === employee.companyId && other.userId &&
        other.id !== employee.id && roleFromTitle(other.roleTitle) === "lider")
      .map((other) => other.userId);
    const text = `AMANHÃ É ANIVERSÁRIO DE ${employee.fullName}${employee.companyName ? ` — ${employee.companyName}` : ""}`;
    const notice = (url: string) => ({
      push: { title: "ANIVERSÁRIO AMANHÃ", body: text, url, tag: `unigames-birthday-${employee.id}-${tomorrow}` },
      task: { date: today, id: `aniv-${employee.id}-${tomorrow}`, text: `${text} (CONTROLE DE ENTREGA EM RH > ANIVERSARIANTES)` },
      onceKey: { key: `aniversario:${employee.id}`, id: "vespera", scheduledFor: tomorrow },
    });
    await notifyUsers(db, vapid, hr, notice("/rh/aniversariantes"));
    await notifyUsers(db, vapid, leaders.filter((id) => !hr.includes(id)), notice("/tarefas"));
  }
}

/**
 * Contratado com item do checklist admissional pendente (ex.: NÃO CADASTRADO
 * NO IFOOD): tarefa todo dia para o RH do Recrutamento e quem cadastrou, até
 * marcar FEITO ou NÃO SE APLICA. Só admissões dos últimos 45 dias.
 */
export async function dispatchAdmissionReminders(db: Db, vapid: Vapid | null, today: string) {
  const result = await db
    .prepare(`SELECT id, full_name AS fullName, admission_company_name AS admissionCompanyName, created_by AS createdBy,
        ${ADMISSION_CHECKLIST.map(([field]) => `${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} AS ${field}`).join(", ")}
      FROM hr_recruitment_candidates
      WHERE status IN ('contratado','integracao') AND admission_date>=?1 AND admission_date<=?2`)
    .bind(addDays(today, -ADMISSION_REMINDER_DAYS), today)
    .all<Record<string, unknown>>();
  const candidates = (result.results ?? [])
    .map((candidate) => ({ candidate, pending: admissionPending(candidate) }))
    .filter((item) => item.pending.length);
  if (!candidates.length) return;
  const recipients = await usersWithPermission(db, ["rh_recrutamento:manage"]);
  for (const { candidate, pending } of candidates) {
    const id = String(candidate.id);
    const store = String(candidate.admissionCompanyName || "");
    const text = `PENDÊNCIAS ADMISSIONAIS — ${candidate.fullName}${store ? ` — ${store}` : ""}: ${pending.join(", ")}`;
    await notifyUsers(db, vapid, [...recipients, String(candidate.createdBy || "")], {
      push: { title: "CHECKLIST ADMISSIONAL PENDENTE", body: text, url: "/rh/recrutamento", tag: `unigames-rec-pend-${id}-${today}` },
      task: { date: today, id: `rec-pend-${id}-${today}`, text },
      onceKey: { key: `rec-pend:${id}`, id: "dia", scheduledFor: today },
    });
  }
}

/** Cron: roda a cada minuto, mas só age na janela das 08:00 (Recife). */
export async function dispatchHrAlerts(db: Db, vapid: Vapid | null, now: { date: string; time: string }) {
  if (now.time < "08:00" || now.time > "08:04") return;
  await dispatchExamAlerts(db, vapid, now.date);
  await dispatchBirthdayEve(db, vapid, now.date);
  await dispatchAdmissionReminders(db, vapid, now.date);
}
