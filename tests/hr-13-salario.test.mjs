import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// 13º SALÁRIO (27/11/2026): só ADIANTAMENTO/PARCELA FINAL; desligado não entra;
// observações no lote; excluir em lote; cada lançamento traz LOJA ADMISSÃO e
// LOJA ATUANTE. Dados fictícios.

const db = await setupRouteDb(["shared_state", "hr_employees", "hr_terminations", "hr_schedule_assignments", "hr_thirteenth_salary"]);
const route = await import("../app/api/hr-payroll/thirteenth/route.ts");
const RH = { id: "rh", name: "RH", permissions: ["payroll:manage"] };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "c-gua", name: "GUARARAPES" }, { id: "c-pnw", name: "PNWS" }]) });
const employee = (id, extra) => db.insert("hr_employees", {
  id, full_name: id.toUpperCase(), cpf: id, admission_date: "2025-01-10", company_id: "c-gua", company_name: "GUARARAPES",
  admission_company_id: "c-pnw", admission_company_name: "PNWS", status: "active", created_by: "rh", ...extra,
});
employee("ana");
employee("bia");
employee("caio", { status: "inactive" });
employee("davi"); // ativo no cadastro, mas com desligamento registrado depois da admissão
db.insert("hr_terminations", { id: "t1", employee_id: "davi", employee_name: "DAVI", termination_date: "2026-10-31", created_by: "rh" });
employee("eva", { admission_date: "2026-03-01" }); // recontratada depois de um desligamento antigo
db.insert("hr_terminations", { id: "t2", employee_id: "eva", employee_name: "EVA", termination_date: "2025-12-20", created_by: "rh" });

const post = (body) => callRoute(route.POST, RH, "POST", "/api/hr-payroll/thirteenth", body);
const get = async () => (await callRoute(route.GET, RH, "GET", "/api/hr-payroll/thirteenth?year=2026")).json();

test("lote: observações gravadas, lojas de admissão/atuante, desligado bloqueado, ÚNICO recusado", async () => {
  const ok = await post({ action: "batch", year: "2026", installment: "adiantamento", rows: [
    { employeeId: "ana", grossCents: 150_000, deductionsCents: 0, notes: "pago junto com a folha" },
    { employeeId: "eva", grossCents: 90_000, deductionsCents: 0 },
  ] });
  assert.equal(ok.status, 200);
  const data = await get();
  const ana = data.entries.find((entry) => entry.employeeId === "ana");
  assert.equal(ana.notes, "PAGO JUNTO COM A FOLHA");
  assert.deepEqual([ana.admissionCompanyName, ana.actingCompanyName, ana.netCents], ["PNWS", "GUARARAPES", 150_000]);
  assert.deepEqual(
    ["ana", "caio", "davi", "eva"].map((id) => data.employeeStores[id].blocked),
    [false, true, true, false],
  );
  for (const blocked of ["caio", "davi"]) {
    const res = await post({ action: "batch", year: "2026", installment: "final", rows: [{ employeeId: blocked, grossCents: 1_000 }] });
    assert.equal(res.status, 409, blocked);
    assert.match((await res.json()).error, /DESLIGADO/);
  }
  assert.equal((await post({ action: "batch", year: "2026", installment: "unico", rows: [{ employeeId: "bia", grossCents: 1_000 }] })).status, 400);
});

test("marcar pago em lote e excluir em lote", async () => {
  await post({ action: "batch", year: "2026", installment: "final", rows: [{ employeeId: "ana", grossCents: 150_000, deductionsCents: 12_000 }, { employeeId: "bia", grossCents: 80_000 }] });
  const ids = (await get()).entries.filter((entry) => entry.installment === "final").map((entry) => entry.id);
  assert.equal((await post({ action: "mark_paid", ids, paymentDone: true, paymentDate: "2026-12-18" })).status, 200);
  assert.ok((await get()).entries.filter((entry) => ids.includes(entry.id)).every((entry) => entry.paymentDone && entry.paymentDate === "2026-12-18"));
  assert.deepEqual(await (await post({ action: "delete", ids })).json(), { deleted: 2 });
  assert.equal((await get()).entries.filter((entry) => entry.installment === "final").length, 0);
});
