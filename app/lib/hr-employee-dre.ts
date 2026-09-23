// DRE Funcionário — fechamento mensal do RH, lógica pura (sem banco).
//
// Consolida, no mês civil, por LOJA e dentro dela por COLABORADOR (nível
// de agregação confirmado com o usuário):
//  - Exames ASO: hr_aso_exams + ASO admissional do candidato do
//    Recrutamento (com data preenchida);
//  - Treinamento pago: hr_recruitment_test_payments (reaproveitado do
//    Recrutamento, sem cópia);
//  - Rescisão e FGTS: hr_terminations;
//  - Aniversariantes: hr_employees.birth_date (mesma fonte do módulo
//    Aniversariantes) — só contagem, não é valor.

export const ASO_EXAM_TYPES = [
  "admissional",
  "periodico",
  "demissional",
  "retorno",
  "mudanca_funcao",
] as const;

export type AsoExamType = (typeof ASO_EXAM_TYPES)[number];

export type DreAso = {
  employeeId: string;
  candidateId: string;
  personName: string;
  companyId: string;
  companyName: string;
  examType: string;
  examDate: string;
  clinicName: string;
  clinicCnpj: string;
  amountCents: number;
  /** 'aso' = lançado em Exames ASO; 'recrutamento' = ASO do candidato. */
  source: "aso" | "recrutamento";
};

export type DreTraining = {
  employeeId: string;
  candidateId: string;
  personName: string;
  companyId: string;
  companyName: string;
  paidDate: string;
  amountCents: number;
  note: string;
};

export type DreTermination = {
  employeeId: string;
  personName: string;
  companyId: string;
  companyName: string;
  terminationDate: string;
  severanceCents: number;
  fgtsCents: number;
};

export type DreBirthday = {
  employeeId: string;
  personName: string;
  companyId: string;
  companyName: string;
  birthDate: string;
};

export type DrePerson = {
  key: string;
  personName: string;
  asoCents: number;
  trainingCents: number;
  severanceCents: number;
  fgtsCents: number;
  totalCents: number;
  /** Aniversário no mês (AAAA-MM-DD da data de nascimento) ou ''. */
  birthDate: string;
};

export type DreTotals = {
  asoCents: number;
  asoCount: number;
  trainingCents: number;
  trainingCount: number;
  severanceCents: number;
  fgtsCents: number;
  terminationsCount: number;
  birthdaysCount: number;
  /** ASO + treinamento + rescisão + FGTS. Aniversário não entra (não é valor). */
  totalCents: number;
};

export type DreStore = {
  companyId: string;
  companyName: string;
  totals: DreTotals;
  people: DrePerson[];
  aso: DreAso[];
  trainings: DreTraining[];
  terminations: DreTermination[];
  birthdays: DreBirthday[];
};

export type EmployeeDre = {
  month: string;
  stores: DreStore[];
  totals: DreTotals;
};

function emptyTotals(): DreTotals {
  return {
    asoCents: 0,
    asoCount: 0,
    trainingCents: 0,
    trainingCount: 0,
    severanceCents: 0,
    fgtsCents: 0,
    terminationsCount: 0,
    birthdaysCount: 0,
    totalCents: 0,
  };
}

function cents(value: unknown) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function personKey(employeeId: string, candidateId: string, personName: string) {
  if (employeeId) return `e:${employeeId}`;
  if (candidateId) return `c:${candidateId}`;
  return `n:${personName}`;
}

export const NO_STORE_LABEL = "Sem loja";

/** Aniversário cai no mês (AAAA-MM) — compara só o mês da data de nascimento. */
export function birthdayInMonth(birthDate: string, month: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(birthDate) && birthDate.slice(5, 7) === month.slice(5, 7);
}

export function buildEmployeeDre(
  month: string,
  sources: {
    aso: DreAso[];
    trainings: DreTraining[];
    terminations: DreTermination[];
    birthdays: DreBirthday[];
  },
): EmployeeDre {
  const stores = new Map<string, DreStore>();
  const people = new Map<string, Map<string, DrePerson>>();

  const storeFor = (companyId: string, companyName: string) => {
    const key = companyId || "";
    let store = stores.get(key);
    if (!store) {
      store = {
        companyId: key,
        companyName: key ? companyName || key : NO_STORE_LABEL,
        totals: emptyTotals(),
        people: [],
        aso: [],
        trainings: [],
        terminations: [],
        birthdays: [],
      };
      stores.set(key, store);
      people.set(key, new Map());
    }
    return store;
  };
  const personFor = (store: DreStore, key: string, personName: string) => {
    const map = people.get(store.companyId)!;
    let person = map.get(key);
    if (!person) {
      person = {
        key,
        personName,
        asoCents: 0,
        trainingCents: 0,
        severanceCents: 0,
        fgtsCents: 0,
        totalCents: 0,
        birthDate: "",
      };
      map.set(key, person);
    }
    return person;
  };

  for (const exam of sources.aso) {
    const store = storeFor(exam.companyId, exam.companyName);
    const amount = cents(exam.amountCents);
    store.aso.push(exam);
    store.totals.asoCents += amount;
    store.totals.asoCount += 1;
    personFor(store, personKey(exam.employeeId, exam.candidateId, exam.personName), exam.personName).asoCents += amount;
  }
  for (const training of sources.trainings) {
    const store = storeFor(training.companyId, training.companyName);
    const amount = cents(training.amountCents);
    store.trainings.push(training);
    store.totals.trainingCents += amount;
    store.totals.trainingCount += 1;
    personFor(
      store,
      personKey(training.employeeId, training.candidateId, training.personName),
      training.personName,
    ).trainingCents += amount;
  }
  for (const termination of sources.terminations) {
    const store = storeFor(termination.companyId, termination.companyName);
    const severance = cents(termination.severanceCents);
    const fgts = cents(termination.fgtsCents);
    store.terminations.push(termination);
    store.totals.severanceCents += severance;
    store.totals.fgtsCents += fgts;
    store.totals.terminationsCount += 1;
    const person = personFor(store, personKey(termination.employeeId, "", termination.personName), termination.personName);
    person.severanceCents += severance;
    person.fgtsCents += fgts;
  }
  for (const birthday of sources.birthdays) {
    if (!birthdayInMonth(birthday.birthDate, month)) continue;
    const store = storeFor(birthday.companyId, birthday.companyName);
    store.birthdays.push(birthday);
    store.totals.birthdaysCount += 1;
    personFor(store, personKey(birthday.employeeId, "", birthday.personName), birthday.personName).birthDate =
      birthday.birthDate;
  }

  const totals = emptyTotals();
  const ordered = [...stores.values()].sort((a, b) => {
    // "Sem loja" sempre por último.
    if (!a.companyId !== !b.companyId) return a.companyId ? -1 : 1;
    return a.companyName.localeCompare(b.companyName, "pt-BR");
  });
  for (const store of ordered) {
    store.totals.totalCents =
      store.totals.asoCents + store.totals.trainingCents + store.totals.severanceCents + store.totals.fgtsCents;
    store.people = [...people.get(store.companyId)!.values()]
      .map((person) => ({
        ...person,
        totalCents: person.asoCents + person.trainingCents + person.severanceCents + person.fgtsCents,
      }))
      .sort((a, b) => a.personName.localeCompare(b.personName, "pt-BR"));
    store.aso.sort((a, b) => a.examDate.localeCompare(b.examDate));
    store.trainings.sort((a, b) => a.paidDate.localeCompare(b.paidDate));
    store.terminations.sort((a, b) => a.terminationDate.localeCompare(b.terminationDate));
    store.birthdays.sort((a, b) => a.birthDate.slice(8, 10).localeCompare(b.birthDate.slice(8, 10)));
    for (const key of Object.keys(totals) as Array<keyof DreTotals>) {
      totals[key] += store.totals[key];
    }
  }
  return { month, stores: ordered, totals };
}
