import assert from "node:assert/strict";
import test from "node:test";

const { buildEmployeeDre, birthdayInMonth, NO_STORE_LABEL } = await import("../app/lib/hr-employee-dre.ts");

const aso = (overrides) => ({
  employeeId: "",
  candidateId: "",
  personName: "",
  companyId: "",
  companyName: "",
  examType: "periodico",
  examDate: "2026-09-10",
  clinicName: "Clínica X",
  clinicCnpj: "",
  amountCents: 0,
  source: "aso",
  ...overrides,
});

test("agrupa por loja e, dentro dela, por colaborador", () => {
  const report = buildEmployeeDre("2026-09", {
    aso: [
      aso({ employeeId: "e1", personName: "Ana", companyId: "l1", companyName: "Loja Centro", amountCents: 8000 }),
      aso({ candidateId: "c9", personName: "Bruno", companyId: "l2", companyName: "Loja Norte", amountCents: 7000, examType: "admissional", source: "recrutamento" }),
    ],
    trainings: [
      { employeeId: "", candidateId: "c9", personName: "Bruno", companyId: "l2", companyName: "Loja Norte", paidDate: "2026-09-02", amountCents: 5000, note: "" },
      { employeeId: "", candidateId: "c9", personName: "Bruno", companyId: "l2", companyName: "Loja Norte", paidDate: "2026-09-03", amountCents: 5000, note: "" },
    ],
    terminations: [
      { employeeId: "e1", personName: "Ana", companyId: "l1", companyName: "Loja Centro", terminationDate: "2026-09-30", severanceCents: 150000, fgtsCents: 40000 },
    ],
    birthdays: [
      { employeeId: "e1", personName: "Ana", companyId: "l1", companyName: "Loja Centro", birthDate: "1990-09-15" },
      { employeeId: "e2", personName: "Caio", companyId: "l1", companyName: "Loja Centro", birthDate: "1995-10-01" },
    ],
  });

  assert.deepEqual(report.stores.map((store) => store.companyName), ["Loja Centro", "Loja Norte"]);
  const centro = report.stores[0];
  assert.equal(centro.totals.asoCents, 8000);
  assert.equal(centro.totals.severanceCents, 150000);
  assert.equal(centro.totals.fgtsCents, 40000);
  // Caio faz aniversário em outubro: não entra.
  assert.equal(centro.totals.birthdaysCount, 1);
  assert.equal(centro.totals.totalCents, 198000);
  assert.equal(centro.people.length, 1);
  assert.equal(centro.people[0].birthDate, "1990-09-15");
  assert.equal(centro.people[0].totalCents, 198000);

  const norte = report.stores[1];
  assert.equal(norte.totals.trainingCents, 10000);
  assert.equal(norte.totals.trainingCount, 2);
  // Candidato não contratado vira uma pessoa só (chave pelo candidato).
  assert.equal(norte.people.length, 1);
  assert.equal(norte.people[0].totalCents, 17000);

  assert.equal(report.totals.totalCents, 215000);
  assert.equal(report.totals.birthdaysCount, 1);
  assert.equal(report.totals.asoCount, 2);
});

test("sem loja vai para o fim com rótulo próprio", () => {
  const report = buildEmployeeDre("2026-09", {
    aso: [
      aso({ employeeId: "e1", personName: "Ana", amountCents: 100 }),
      aso({ employeeId: "e2", personName: "Beto", companyId: "l1", companyName: "Loja A", amountCents: 100 }),
    ],
    trainings: [],
    terminations: [],
    birthdays: [],
  });
  assert.deepEqual(report.stores.map((store) => store.companyName), ["Loja A", NO_STORE_LABEL]);
});

test("mês sem lançamentos devolve lista vazia e totais zerados", () => {
  const report = buildEmployeeDre("2026-09", { aso: [], trainings: [], terminations: [], birthdays: [] });
  assert.equal(report.stores.length, 0);
  assert.equal(report.totals.totalCents, 0);
});

test("aniversário compara só o mês da data de nascimento", () => {
  assert.equal(birthdayInMonth("1990-09-15", "2026-09"), true);
  assert.equal(birthdayInMonth("1990-10-15", "2026-09"), false);
  assert.equal(birthdayInMonth("", "2026-09"), false);
});
