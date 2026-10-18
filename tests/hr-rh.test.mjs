import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// RH (out/2026): aviso na mudança de status do Recrutamento, tarefa do dia
// seguinte ao salvar o PDI, desligamento exige data e motivo, vencimento do
// ASO = exame + 12 meses e alertas só de ativos, aniversário na véspera,
// indicadores do Dashboard com filtros e vídeo do Onboarding que só conclui
// assistido até o fim. Rotas reais sobre SQLite em memória.

const db = await setupRouteDb([
  "shared_state", "app_users", "push_subscriptions", "push_delivery_log", "hr_settings",
  "hr_employees", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_terminations", "hr_aso_exams",
  "hr_recruitment_candidates", "hr_recruitment_status_history", "hr_recruitment_test_payments", "hr_leader_pdi",
  "hr_onboarding_videos", "hr_onboarding_progress",
]);
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "clojaalfa1", name: "LOJA ALFA" }, { id: "clojabeta1", name: "LOJA BETA" }]) });
db.insert("app_users", { id: "rh1", username: "rh1", display_name: "RH", password_hash: "x", password_salt: "x", role: "user", access_group: "custom", permissions_json: JSON.stringify(["rh_recrutamento:manage", "rh_exames:view", "rh_aniversariantes:view", "rh_onboarding:track"]), active: 1 });
db.insert("app_users", { id: "lider1", username: "lider1", display_name: "LIDER", password_hash: "x", password_salt: "x", role: "user", access_group: "custom", permissions_json: "[]", active: 1 });
db.insert("app_users", { id: "colab1", username: "colab1", display_name: "COLAB", password_hash: "x", password_salt: "x", role: "user", access_group: "custom", permissions_json: "[]", active: 1 });

const lib = await import("../app/lib/hr-rh.ts");
const alerts = await import("../app/lib/hr-alerts.ts");
const candidates = await import("../app/api/hr-recruitment/candidates/route.ts");
const employees = await import("../app/api/hr-payroll/employees/route.ts");
const pdi = await import("../app/api/hr-store-tracking/leader-pdi/route.ts");
const dashboard = await import("../app/api/hr-rh/dashboard/route.ts");
const onboarding = await import("../app/api/hr-rh/onboarding/route.ts");
const progress = await import("../app/api/hr-rh/onboarding/progress/route.ts");

const ADMIN = { id: "admin1", role: "admin", name: "ADMIN" };
const tasksOf = (userId, date) => {
  const row = db.sqlite.prepare("SELECT value_json FROM shared_state WHERE state_key=?").get(`tarefas:${userId}:${date}`);
  return row ? JSON.parse(row.value_json).tasks : [];
};
const today = lib.recifeToday();

test("recrutamento: mudança de status gera tarefa com a pendência para o RH e grava o histórico", async () => {
  const created = await callRoute(candidates.POST, ADMIN, "POST", "/api/hr-recruitment/candidates", { fullName: "joana lima" });
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  const moved = await callRoute(candidates.POST, ADMIN, "POST", "/api/hr-recruitment/candidates", {
    id, fullName: "joana lima", status: "em_teste", fixedUnitName: "LOJA ALFA",
  });
  assert.equal(moved.status, 200);
  const task = tasksOf("rh1", today).find((item) => item.id === `rec-${id}-em_teste`);
  assert.ok(task, "RH recebe a tarefa");
  assert.equal(task.text, "PENDENTE DE TESTE — JOANA LIMA — LOJA ALFA");
  const history = db.sqlite.prepare("SELECT from_status, to_status, changed_by FROM hr_recruitment_status_history WHERE candidate_id=? AND to_status='em_teste'").get(id);
  assert.deepEqual({ ...history }, { from_status: "selecionado_entrevista", to_status: "em_teste", changed_by: "admin1" });
  // Cancelado = só aviso, sem tarefa.
  await callRoute(candidates.POST, ADMIN, "POST", "/api/hr-recruitment/candidates", { id, fullName: "joana lima", status: "cancelado" });
  assert.equal(tasksOf("rh1", today).some((item) => item.id === `rec-${id}-cancelado`), false);
});

test("PDI: salvar cria tarefa no dia seguinte e lembrete no prazo de cada ação", async () => {
  const response = await callRoute(pdi.POST, ADMIN, "POST", "/api/hr-store-tracking/leader-pdi", {
    leaderName: "carlos", companyId: "clojaalfa1", companyName: "LOJA ALFA", meetingDate: today,
    transcriptText: "fala 1\nfala 2", agreedText: "melhorar vitrine",
    nextActions: [{ action: "organizar vitrine", owner: "carlos", dueDate: "2099-01-10" }, { action: "", owner: "x" }],
  });
  assert.equal(response.status, 201);
  const id = (await response.json()).id;
  const tomorrow = lib.addDays(today, 1);
  const next = tasksOf("admin1", tomorrow).find((item) => item.id === `pdi-${id}`);
  assert.ok(next, "tarefa no dia seguinte");
  assert.match(next.text, /ORGANIZAR VITRINE — RESP: CARLOS — PRAZO 10\/01\/2099/);
  assert.equal(next.time, "09:00");
  assert.ok(tasksOf("admin1", "2099-01-10").find((item) => item.id === `pdi-${id}-acao-1`), "lembrete no prazo");
  const saved = db.sqlite.prepare("SELECT next_actions_json, transcript_text FROM hr_leader_pdi WHERE id=?").get(id);
  assert.equal(JSON.parse(saved.next_actions_json).length, 1, "ação vazia é descartada");
});

test("desligamento: só fica INATIVO com data e motivo; checklist pode ficar pendente", async () => {
  const created = await callRoute(employees.POST, ADMIN, "POST", "/api/hr-payroll/employees", { fullName: "pedro", companyId: "clojaalfa1", admissionDate: "2026-01-05" });
  const id = (await created.json()).id;
  const base = { id, fullName: "pedro", companyId: "clojaalfa1", admissionDate: "2026-01-05", status: "inactive" };
  assert.equal((await callRoute(employees.POST, ADMIN, "POST", "/api/hr-payroll/employees", base)).status, 400);
  const noReason = await callRoute(employees.POST, ADMIN, "POST", "/api/hr-payroll/employees", { ...base, termination: { terminationDate: "2026-10-10" } });
  assert.equal((await noReason.json()).error, "INFORME O MOTIVO DO DESLIGAMENTO.");
  assert.equal(db.sqlite.prepare("SELECT status FROM hr_employees WHERE id=?").get(id).status, "active");
  const ok = await callRoute(employees.POST, ADMIN, "POST", "/api/hr-payroll/employees", {
    ...base, termination: { terminationDate: "2026-10-10", reason: "pedido_demissao", checklist: { aviso_previo: { status: "feito", note: "ok" } } },
  });
  assert.equal(ok.status, 200);
  const termination = db.sqlite.prepare("SELECT termination_date, reason, checklist_json FROM hr_terminations WHERE employee_id=?").get(id);
  assert.equal(termination.reason, "pedido_demissao");
  assert.equal(lib.checklistPendingCount(termination.checklist_json), 8);
  const listed = (await (await callRoute(employees.GET, ADMIN, "GET", "/api/hr-payroll/employees")).json()).employees.find((e) => e.id === id);
  assert.equal(listed.offboardingPending, 8, "alerta de checklist pendente na lista");
});

test("exames: vencimento = exame + 12 meses; SEM EXAME e alertas só de funcionários ativos", async () => {
  assert.equal(lib.asoExpiry("2025-10-18"), "2026-10-18");
  assert.equal(lib.asoExpiry("2024-02-29"), "2025-02-28");
  assert.equal(lib.asoExpiry("2025-10-18", "2026-01-01"), "2026-01-01", "vencimento informado prevalece");
  db.insert("hr_employees", { id: "e-ativo", full_name: "ANA", status: "active", company_id: "clojaalfa1", company_name: "LOJA ALFA", created_by: "x" });
  db.insert("hr_employees", { id: "e-inativo", full_name: "BRUNO", status: "inactive", company_id: "clojaalfa1", created_by: "x" });
  db.insert("hr_employees", { id: "e-sem", full_name: "CAIO", status: "active", company_id: "clojabeta1", created_by: "x" });
  const day = "2026-10-18";
  db.insert("hr_aso_exams", { id: "a1", employee_id: "e-ativo", exam_type: "periodico", exam_date: "2025-11-17", expiry_date: "" });
  db.insert("hr_aso_exams", { id: "a2", employee_id: "e-inativo", exam_type: "periodico", exam_date: "2025-11-17", expiry_date: "" });
  const rows = await alerts.loadExamStatus(db, day);
  assert.equal(rows.some((row) => row.employeeId === "e-inativo"), false);
  const ana = rows.find((row) => row.employeeId === "e-ativo");
  assert.equal(ana.expiryDate, "2026-11-17");
  assert.equal(ana.daysLeft, 30);
  assert.equal(ana.situation, "30");
  assert.equal(rows.find((row) => row.employeeId === "e-sem").situation, "sem_exame");
  await alerts.dispatchExamAlerts(db, null, day);
  assert.ok(tasksOf("rh1", day).some((item) => item.id === "aso-e-ativo-2026-11-17-30"));
  assert.equal(tasksOf("rh1", day).some((item) => item.id.startsWith("aso-e-inativo")), false);
  // Uma vez só por login (cron roda a cada minuto).
  await alerts.dispatchExamAlerts(db, null, day);
  assert.equal(tasksOf("rh1", day).filter((item) => item.id.startsWith("aso-e-ativo")).length, 1);
});

test("aniversário: aviso na véspera para o RH e o líder da loja", async () => {
  db.insert("hr_employees", { id: "e-aniv", full_name: "DORA", status: "active", company_id: "clojaalfa1", company_name: "LOJA ALFA", birth_date: "1990-10-19", created_by: "x" });
  db.insert("hr_employees", { id: "e-lider", full_name: "LUIZ", status: "active", company_id: "clojaalfa1", role_title: "LÍDER DE LOJA", user_id: "lider1", birth_date: "1990-01-01", created_by: "x" });
  await alerts.dispatchBirthdayEve(db, null, "2026-10-18");
  const expected = "AMANHÃ É ANIVERSÁRIO DE DORA — LOJA ALFA (CONTROLE DE ENTREGA EM RH > ANIVERSARIANTES)";
  assert.equal(tasksOf("rh1", "2026-10-18").find((item) => item.id === "aniv-e-aniv-2026-10-19").text, expected);
  assert.ok(tasksOf("lider1", "2026-10-18").find((item) => item.id === "aniv-e-aniv-2026-10-19"));
  await alerts.dispatchBirthdayEve(db, null, "2026-10-17");
  assert.equal(tasksOf("rh1", "2026-10-17").length, 0, "só na véspera");
  assert.equal(lib.isBirthdayOn("2000-02-29", "2027-02-28"), true);
});

test("dashboard: admitidos, demitidos, turnover e recrutamento com filtros", async () => {
  db.sqlite.exec("DELETE FROM hr_employees; DELETE FROM hr_terminations; DELETE FROM hr_recruitment_candidates;");
  const emp = (id, admission, status, company) => db.insert("hr_employees", { id, full_name: id.toUpperCase(), admission_date: admission, status, company_id: company, created_by: "x" });
  emp("a", "2026-01-10", "active", "clojaalfa1");
  emp("b", "2026-01-10", "active", "clojaalfa1");
  emp("c", "2026-09-05", "active", "clojaalfa1");
  emp("d", "2026-01-10", "inactive", "clojaalfa1");
  emp("e", "2026-09-10", "active", "clojabeta1");
  db.insert("hr_terminations", { id: "t1", employee_id: "d", employee_name: "D", company_id: "clojaalfa1", termination_date: "2026-09-20" });
  const cand = (id, date, result, status, store) => db.insert("hr_recruitment_candidates", { id, full_name: id.toUpperCase(), interview_date: date, interview_result: result, status, fixed_unit_id: store, created_by: "x" });
  cand("c1", "2026-09-02", "aprovado", "em_teste", "clojaalfa1");
  cand("c2", "2026-09-03", "reprovado", "cancelado", "clojaalfa1");
  cand("c3", "2026-09-01", "aprovado", "em_treinamento", "clojabeta1");
  cand("c4", "2026-08-15", "aprovado", "contratado", "clojaalfa1");
  const get = async (query) => (await callRoute(dashboard.GET, ADMIN, "GET", `/api/hr-rh/dashboard?${query}`)).json();
  const alfa = await get("from=2026-09-01&to=2026-09-30&companyId=clojaalfa1");
  assert.equal(alfa.current.admitted, 1);
  assert.equal(alfa.current.dismissed, 1);
  // Ativos: início 3 (a, b, d) e fim 3 (a, b, c) → ((1+1)/2)/3 = 33,3%.
  assert.equal(alfa.current.turnover, 33.3);
  assert.equal(alfa.current.scheduled, 2);
  assert.equal(alfa.current.approved, 1);
  assert.equal(alfa.current.rejected, 1);
  assert.deepEqual(alfa.admissionQueue.map((item) => item.id), ["c1"]);
  assert.equal(alfa.before.scheduled, 1, "período anterior (agosto)");
  const all = await get("from=2026-09-01&to=2026-09-30");
  assert.deepEqual(all.admissionQueue.map((item) => item.id), ["c3", "c1"], "fila por data");
  const person = await get("from=2026-09-01&to=2026-09-30&person=c3");
  assert.equal(person.current.scheduled, 1);
  assert.equal((await callRoute(dashboard.GET, { id: "x", permissions: ["rh_exames:view"] }, "GET", "/api/hr-rh/dashboard?from=2026-09-01&to=2026-09-30")).status, 403);
});

test("onboarding: vídeo só conclui assistido até o fim; pular não conta", async () => {
  assert.equal(lib.acceptWatched(0, 600, 10, 600), 15, "pulou para o fim: só conta o tempo real");
  assert.equal(lib.acceptWatched(100, 108, 10, 600), 108);
  assert.equal(lib.videoCompleted(599, 600), true);
  assert.equal(lib.videoCompleted(500, 600), false);
  db.insert("hr_employees", { id: "e-novo", full_name: "NINA", status: "active", company_id: "clojaalfa1", role_title: "VENDEDOR", user_id: "colab1", onboarding_started_at: "2026-10-18T10:00:00Z", created_by: "x" });
  db.insert("hr_onboarding_videos", { id: "v1", title: "BOAS-VINDAS", role_title: "VENDEDOR", r2_key: "hr-onboarding/v1/a.mp4", duration_seconds: 20, active: 1 });
  db.insert("hr_onboarding_videos", { id: "v2", title: "SÓ ASSISTÊNCIA", role_title: "TÉCNICO", r2_key: "hr-onboarding/v2/a.mp4", duration_seconds: 20, active: 1 });
  const COLAB = { id: "colab1" };
  const my = await (await callRoute(onboarding.GET, COLAB, "GET", "/api/hr-rh/onboarding?scope=my")).json();
  assert.deepEqual(my.videos.map((video) => video.id), ["v1"], "trilha do cargo");
  const beat = async (watchedSeconds) => (await callRoute(progress.POST, COLAB, "POST", "/api/hr-rh/onboarding/progress", { videoId: "v1", watchedSeconds, positionSeconds: watchedSeconds })).json();
  assert.equal((await beat(20)).completed, false, "adiantar até o fim não conclui");
  // Simula 30 s de vídeo assistido de verdade.
  db.sqlite.prepare("UPDATE hr_onboarding_progress SET updated_at=? WHERE video_id='v1'").run(new Date(Date.now() - 30000).toISOString());
  assert.equal((await beat(20)).completed, true);
  const employee = db.sqlite.prepare("SELECT onboarding_completed_at FROM hr_employees WHERE id='e-novo'").get();
  assert.ok(employee.onboarding_completed_at, "trilha concluída");
  assert.ok(tasksOf("rh1", today).some((item) => item.id === "onboarding-e-novo"), "tarefa da reunião de onboarding");
  const track = await (await callRoute(onboarding.GET, { id: "rh1", permissions: ["rh_onboarding:track"] }, "GET", "/api/hr-rh/onboarding?scope=track")).json();
  assert.equal(track.people.find((person) => person.id === "e-novo").percent, 100);
  assert.equal((await callRoute(onboarding.GET, COLAB, "GET", "/api/hr-rh/onboarding?scope=track")).status, 403);
});
