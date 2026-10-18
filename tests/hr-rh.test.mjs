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
  "hr_onboarding_videos", "hr_onboarding_progress", "hr_store_followups", "hr_time_tracking_entries",
  "hr_time_tracking_settings", "hr_schedule_assignments",
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
  assert.equal(lib.checklistPendingCount(termination.checklist_json), 14);
  assert.equal(lib.checklistPendingCount("{}"), 0, "rescisão anterior ao checklist não gera alerta");
  const listed = (await (await callRoute(employees.GET, ADMIN, "GET", "/api/hr-payroll/employees")).json()).employees.find((e) => e.id === id);
  assert.equal(listed.offboardingPending, 14, "alerta de checklist pendente na lista");
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

const contacts = await import("../app/api/hr-recruitment/contacts/route.ts");
const dre = await import("../app/api/hr-payroll/employee-dre/route.ts");
const followups = await import("../app/api/hr-store-tracking/followups/route.ts");
const timeEntries = await import("../app/api/hr-time-tracking/entries/route.ts");
const offboarding = await import("../app/api/hr-rh/offboarding/route.ts");

test("recrutamento por etapas: telefone, NÃO SE APLICA, filtro CONTRATADO inclui INTEGRAÇÃO e contatos em lote", async () => {
  const created = await callRoute(candidates.POST, ADMIN, "POST", "/api/hr-recruitment/candidates", { fullName: "lia", phone: "(81) 99999-0000" });
  const id = (await created.json()).id;
  db.sqlite.prepare("UPDATE hr_recruitment_candidates SET status='integracao' WHERE id=?").run(id);
  const hired = (await (await callRoute(candidates.GET, ADMIN, "GET", "/api/hr-recruitment/candidates?status=contratado")).json()).candidates;
  assert.ok(hired.some((row) => row.id === id), "INTEGRAÇÃO aparece no filtro CONTRATADO");
  assert.equal(hired.find((row) => row.id === id).phone, "(81) 99999-0000");
  assert.equal(lib.checklistValue("na"), 2);
  assert.equal(lib.checklistValue("sim"), 1);
  assert.equal(lib.checklistValue("nao"), 0);
  const saved = await callRoute(contacts.POST, ADMIN, "POST", "/api/hr-recruitment/contacts", { items: [{ id, fullName: "lia souza", phone: "81988887777" }] });
  assert.equal(saved.status, 200);
  assert.deepEqual({ ...db.sqlite.prepare("SELECT full_name, phone FROM hr_recruitment_candidates WHERE id=?").get(id) }, { full_name: "LIA SOUZA", phone: "81988887777" });
  assert.equal((await callRoute(contacts.POST, { id: "v", permissions: ["rh_recrutamento:view"] }, "POST", "/api/hr-recruitment/contacts", { items: [] })).status, 403);
});

test("recrutamento: lembrete diário dos itens pendentes do checklist admissional (NÃO SE APLICA não cobra)", async () => {
  const day = "2026-10-18";
  const all = Object.fromEntries(lib.ADMISSION_CHECKLIST.map(([field]) => [field.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()), 1]));
  db.insert("hr_recruitment_candidates", { id: "c-pend", full_name: "RUI", status: "contratado", admission_date: "2026-10-10", admission_company_name: "LOJA ALFA", created_by: "admin1", ...all, ifood_done: 0, payjoy_done: 2 });
  db.insert("hr_recruitment_candidates", { id: "c-velho", full_name: "VELHO", status: "contratado", admission_date: "2026-01-10", created_by: "admin1" });
  await alerts.dispatchAdmissionReminders(db, null, day);
  const task = tasksOf("rh1", day).find((item) => item.id === "rec-pend-c-pend-" + day);
  assert.equal(task.text, "PENDÊNCIAS ADMISSIONAIS — RUI — LOJA ALFA: IFOOD");
  assert.equal(tasksOf("rh1", day).some((item) => item.id.startsWith("rec-pend-c-velho")), false, "admissão antiga não é cobrada");
});

test("desligamento: rescisão paga com data", async () => {
  db.insert("hr_terminations", { id: "t-pago", employee_id: "x", employee_name: "X", termination_date: "2026-10-01", checklist_json: "{}" });
  const response = await callRoute(offboarding.POST, ADMIN, "POST", "/api/hr-rh/offboarding", { id: "t-pago", terminationDate: "2026-10-01", reason: "acordo", severancePaidDate: "2026-10-11", checklist: {} });
  assert.equal(response.status, 200);
  assert.equal(db.sqlite.prepare("SELECT severance_paid_date FROM hr_terminations WHERE id='t-pago'").get().severance_paid_date, "2026-10-11");
  assert.equal((await callRoute(offboarding.POST, ADMIN, "POST", "/api/hr-rh/offboarding", { id: "t-pago", terminationDate: "2026-10-01", reason: "acordo", severancePaidDate: "11/10" })).status, 400);
});

test("DRE: por CNPJ com FGTS de 8% do salário (loja do mês das Escalas) e dias pagos do treinamento", async () => {
  db.sqlite.exec("DELETE FROM hr_employees; DELETE FROM hr_terminations; DELETE FROM hr_recruitment_candidates; DELETE FROM hr_aso_exams;");
  db.sqlite.prepare("UPDATE shared_state SET value_json=? WHERE state_key='companies_list'").run(JSON.stringify([
    { id: "clojaalfa1", name: "LOJA ALFA", cnpj: "11.222.333/0001-81" },
    { id: "clojabeta1", name: "LOJA BETA", cnpj: "11222333000181" },
    { id: "clojagama1", name: "LOJA GAMA", cnpj: "" },
  ]));
  const emp = (id, company, salary, extra = {}) => db.insert("hr_employees", { id, full_name: id.toUpperCase(), company_id: company, salary_cents: salary, status: "active", admission_date: "2026-01-01", created_by: "x", ...extra });
  emp("p1", "clojaalfa1", 200000);
  emp("p2", "clojabeta1", 300000);
  emp("p3", "clojagama1", 100000);
  emp("p4", "clojagama1", 150000, { admission_date: "2026-11-01" });
  db.insert("hr_schedule_assignments", { id: "s1", employee_id: "p3", employee_name: "P3", company_id: "clojaalfa1", reference_month: "2026-10" });
  db.insert("hr_recruitment_candidates", { id: "c-tr", full_name: "TREINO", status: "em_treinamento", fixed_unit_id: "clojaalfa1", fixed_unit_name: "LOJA ALFA", created_by: "x" });
  db.insert("hr_recruitment_test_payments", { id: "tp1", candidate_id: "c-tr", amount_cents: 5000, paid_date: "2026-10-05" });
  db.insert("hr_recruitment_test_payments", { id: "tp2", candidate_id: "c-tr", amount_cents: 5000, paid_date: "2026-10-03" });
  const report = await (await callRoute(dre.GET, ADMIN, "GET", "/api/hr-payroll/employee-dre?month=2026-10")).json();
  const sameCnpj = report.byCnpj.find((row) => row.cnpj === "11222333000181");
  assert.equal(sameCnpj.headcount, 3, "ALFA + BETA (mesmo CNPJ) + P3 escalado na ALFA no mês");
  assert.equal(sameCnpj.salaryCents, 600000);
  assert.equal(sameCnpj.fgtsMonthCents, 48000);
  assert.equal(sameCnpj.trainingCents, 10000);
  assert.equal(report.byCnpj.some((row) => row.cnpj === "" && row.headcount > 0), false, "admitido em novembro não conta em outubro");
  const person = report.stores.find((store) => store.companyId === "clojaalfa1").people.find((item) => item.personName === "TREINO");
  assert.deepEqual(person.trainingDates, ["2026-10-03", "2026-10-05"]);
});

test("acompanhamento por liderado: ciclo com 3 encontros (online, online, presencial) e filtro por loja", async () => {
  const MANAGER = { id: "m", permissions: ["rh_acompanhamento:manage"] };
  const post = (body) => callRoute(followups.POST, MANAGER, "POST", "/api/hr-store-tracking/followups", body);
  const cycle = { action: "cycle", companyId: "clojaalfa1", companyName: "LOJA ALFA", leaderName: "LUIZ", leaderArea: "operacional", memberName: "ana", cycleStart: "2026-10-05" };
  assert.equal((await post(cycle)).status, 201);
  assert.equal((await post(cycle)).status, 409, "mesmo ciclo não duplica");
  const list = (await (await callRoute(followups.GET, MANAGER, "GET", "/api/hr-store-tracking/followups?companyId=clojaalfa1")).json()).followups;
  assert.deepEqual(list.map((row) => [row.week, row.mode, row.meetingDate]), [[1, "online", "2026-10-05"], [2, "online", "2026-10-12"], [3, "presencial", "2026-10-19"]]);
  assert.equal(list[0].memberName, "ANA");
  assert.equal((await post({ action: "meeting", id: list[2].id, meetingDate: "2026-10-20", done: true, topic: "vitrine", notes: "feito" })).status, 200);
  assert.equal(db.sqlite.prepare("SELECT done FROM hr_store_followups WHERE id=?").get(list[2].id).done, 1);
  assert.equal((await callRoute(followups.GET, MANAGER, "GET", "/api/hr-store-tracking/followups?companyId=clojabeta1").then((r) => r.json())).followups.length, 0);
  assert.equal((await callRoute(followups.POST, { id: "v", permissions: ["rh_acompanhamento:view"] }, "POST", "/api/hr-store-tracking/followups", cycle)).status, 403);
});

test("ponto em grade: salva o mês de uma vez, apaga dia limpo e recusa marcação inválida", async () => {
  const MANAGER = { id: "pm", permissions: ["rh_ponto_logistica:manage"] };
  db.insert("hr_time_tracking_settings", { id: "set1", employee_id: "log1", daily_target_minutes: 528, notes: "", created_by: "x" });
  db.insert("hr_time_tracking_entries", { id: "old", employee_id: "log1", entry_date: "2026-10-03", punches: "08:00,12:00", worked_minutes: 240, target_minutes: 528, balance_minutes: -288, created_by: "x" });
  const put = (days) => callRoute(timeEntries.PUT, MANAGER, "PUT", "/api/hr-time-tracking/entries", { employeeId: "log1", month: "2026-10", days });
  const ok = await put([
    { entryDate: "2026-10-01", punches: "08:00,12:00,13:00,17:48" },
    { entryDate: "2026-10-02", punches: "08:00,12:00,13:00,18:00" },
    { entryDate: "2026-10-03", punches: "" },
  ]);
  assert.equal(ok.status, 200);
  const rows = db.sqlite.prepare("SELECT entry_date, worked_minutes, balance_minutes FROM hr_time_tracking_entries WHERE employee_id='log1' ORDER BY entry_date").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { entry_date: "2026-10-01", worked_minutes: 528, balance_minutes: 0 },
    { entry_date: "2026-10-02", worked_minutes: 540, balance_minutes: 12 },
  ], "jornada 8h48 e dia limpo apagado");
  const bad = await put([{ entryDate: "2026-10-04", punches: "08:00" }]);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /^04\/10:/);
});
