import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Plano Odontológico (24/11/2026): FALTANDO/SOLICITADA separados em
// INCLUIR/EXCLUIR, MOTIVO preenchido pelo status (e mostrado — a CAIXA ALTA
// gravava "EXCLUSAO" e a tela não achava o rótulo), admissão vira FALTANDO
// INCLUIR e desligamento vira FALTANDO EXCLUIR sozinhos. Nº DO PROCESSO fica
// em branco (protocolo da operadora, o RH digita).

const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const db = await setupRouteDb([...schema.matchAll(/pgTable\(\s*"([a-z0-9_]+)"/g)].map((match) => match[1]));
const ALFA = "clojaalfa1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "Guararapes", cnpj: "23189383000193" }]) });
const ADMIN = { id: "admin", role: "admin", name: "ADMIN" };
const dental = await import("../app/api/hr-dental-plan/route.ts");
const employees = await import("../app/api/hr-payroll/employees/route.ts");
const terminations = await import("../app/api/hr-payroll/terminations/route.ts");
const rows = (employeeId) => db.sqlite.prepare("SELECT status, reason, unit_name, cnpj, process_number, notes FROM hr_dental_plan WHERE employee_id=?").all(employeeId).map((row) => ({ ...row }));
const list = async (query = "") => (await (await callRoute(dental.GET, ADMIN, "GET", `/api/hr-dental-plan${query}`)).json()).items;

test("admissão (cadastro novo ativo) cria FALTANDO INCLUIR com motivo, unidade, CNPJ e observação", async () => {
  const response = await callRoute(employees.POST, ADMIN, "POST", "/api/hr-payroll/employees", {
    fullName: "dayvid lucas", companyId: ALFA, status: "active", workSchedule: "5x2", admissionDate: "2026-11-23",
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const { id } = await response.json();
  assert.deepEqual(rows(id), [{
    status: "faltando_incluir", reason: "inclusao", unit_name: "GUARARAPES", cnpj: "23.189.383/0001-93",
    process_number: "", notes: "ADMITIDO EM 23/11/2026 · GUARARAPES",
  }]);
  const item = (await list()).find((row) => row.employeeId === id);
  assert.equal(item.reason, "inclusao");
});

test("desligamento: incluso vira FALTANDO EXCLUIR (observação na frente); sem registro cria a pendência", async () => {
  db.insert("hr_employees", { id: "inc", full_name: "VICTOR HUGO", company_id: ALFA, company_name: "GUARARAPES", status: "active", admission_date: "2025-01-01", created_by: "x" });
  db.insert("hr_dental_plan", { id: "d-inc", employee_id: "inc", employee_name: "VICTOR HUGO", status: "incluso", reason: "inclusao", process_number: "16033689", notes: "INCLUÍDO EM JANEIRO" });
  db.insert("hr_employees", { id: "sem", full_name: "WILLIAN LUCAS", company_id: ALFA, company_name: "GUARARAPES", status: "active", admission_date: "2025-01-01", created_by: "x" });

  let response = await callRoute(terminations.POST, ADMIN, "POST", "/api/hr-payroll/terminations", {
    employeeId: "inc", terminationDate: "2026-11-13", reason: "pedido_demissao",
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  assert.deepEqual(rows("inc"), [{
    status: "faltando_excluir", reason: "exclusao", unit_name: "", cnpj: "", process_number: "16033689",
    notes: "DESLIGADO EM 13/11/2026 · PEDIDO DE DEMISSÃO · INCLUÍDO EM JANEIRO",
  }]);

  // Inativar pelo EDITAR do cadastro também.
  response = await callRoute(employees.POST, ADMIN, "POST", "/api/hr-payroll/employees", {
    id: "sem", fullName: "WILLIAN LUCAS", companyId: ALFA, status: "inactive", workSchedule: "5x2",
    termination: { terminationDate: "2026-11-23", reason: "sem_justa_causa" },
  });
  assert.ok(response.status < 300, JSON.stringify(await response.clone().json()));
  assert.deepEqual(rows("sem"), [{
    status: "faltando_excluir", reason: "exclusao", unit_name: "GUARARAPES", cnpj: "23.189.383/0001-93",
    process_number: "", notes: "DESLIGADO EM 23/11/2026 · DISPENSA SEM JUSTA CAUSA",
  }]);
});

test("já DESLIGADO no plano não volta para pendente", async () => {
  db.insert("hr_employees", { id: "old", full_name: "JOSÉ GUILHERME", company_id: ALFA, company_name: "GUARARAPES", status: "active", admission_date: "2025-01-01", created_by: "x" });
  db.insert("hr_dental_plan", { id: "d-old", employee_id: "old", employee_name: "JOSÉ GUILHERME", status: "desligado", reason: "exclusao", process_number: "16002349" });
  const response = await callRoute(terminations.POST, ADMIN, "POST", "/api/hr-payroll/terminations", {
    employeeId: "old", terminationDate: "2026-11-20", reason: "acordo",
  });
  assert.equal(response.status, 201);
  assert.equal(rows("old").length, 1);
  assert.equal(rows("old")[0].status, "desligado");
});

test("formulário: status novos, motivo vazio = o do status, motivo antigo em CAIXA ALTA aparece e filtra", async () => {
  db.insert("hr_employees", { id: "man", full_name: "ALEX", company_id: ALFA, company_name: "GUARARAPES", status: "active", admission_date: "2025-01-01", created_by: "x" });
  let response = await callRoute(dental.POST, ADMIN, "POST", "/api/hr-dental-plan", {
    employeeId: "man", employeeName: "ALEX", status: "exclusao_solicitada", reason: "", processNumber: "777", notes: "pedido",
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  assert.deepEqual(rows("man")[0], { status: "exclusao_solicitada", reason: "exclusao", unit_name: "", cnpj: "", process_number: "777", notes: "PEDIDO" });

  response = await callRoute(dental.POST, ADMIN, "POST", "/api/hr-dental-plan", { employeeName: "X", status: "faltando_incluir_excluir" });
  assert.equal(response.status, 400, "status antigo não vale mais");

  db.insert("hr_dental_plan", { id: "d-caps", employee_id: "", employee_name: "LEGADO", status: "faltando_excluir", reason: "EXCLUSAO" });
  const legado = (await list()).find((row) => row.employeeName === "LEGADO");
  assert.equal(legado.reason, "exclusao");
  assert.ok((await list("?reason=exclusao")).some((row) => row.employeeName === "LEGADO"));
});

test("migration 0146 só converte dados; tela tem os status separados", async () => {
  const sql = await readFile(new URL("../drizzle/0146_rh_odonto_status_incluir_excluir.sql", import.meta.url), "utf8");
  assert.match(sql, /WHERE d\."status" = 'faltando_incluir_excluir'/);
  assert.match(sql, /WHERE d\."status" = 'inclusao_exclusao_solicitada'/);
  assert.doesNotMatch(sql, /DROP|DELETE|INSERT/i);
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  for (const label of ["FALTANDO INCLUIR", "FALTANDO EXCLUIR", "INCLUSÃO SOLICITADA", "EXCLUSÃO SOLICITADA"]) {
    assert.match(html, new RegExp(`<option value="[a-z_]+">${label}</option>`));
  }
  assert.doesNotMatch(html, /faltando_incluir_excluir|inclusao_exclusao_solicitada/);
  assert.match(html, /const dentalReasonOf = row =>/);
});

test("Recrutamento: candidato CONTRATADO nasce FALTANDO INCLUIR no plano", async () => {
  const candidates = await import("../app/api/hr-recruitment/candidates/route.ts");
  db.insert("hr_recruitment_candidates", {
    id: "11111111-2222-3333-4444-555555555555", full_name: "PEDRO GABRIEL", status: "em_treinamento",
    admission_date: "2026-11-23", admission_company_id: ALFA, admission_company_name: "GUARARAPES", created_by: "admin",
  });
  const response = await callRoute(candidates.POST, ADMIN, "POST", "/api/hr-recruitment/candidates", {
    id: "11111111-2222-3333-4444-555555555555", fullName: "PEDRO GABRIEL", status: "contratado",
    admissionDate: "2026-11-23", admissionCompanyId: ALFA, admissionCompanyName: "GUARARAPES",
  });
  const body = await response.json();
  assert.ok(response.status < 300, JSON.stringify(body));
  assert.ok(body.hrEmployeeId);
  assert.deepEqual(rows(body.hrEmployeeId).map((row) => [row.status, row.reason, row.notes]), [
    ["faltando_incluir", "inclusao", "ADMITIDO EM 23/11/2026 · GUARARAPES"],
  ]);
});
