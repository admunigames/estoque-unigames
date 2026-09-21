// RH > Aniversariantes — lógica pura (sem dependência de banco), testada
// isoladamente em tests/hr-birthdays.test.mjs. Reexportada por
// app/api/hr-birthdays/shared.ts pros handlers de rota.

export const BIRTH_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export type BirthdayStatus = "feito" | "passou" | "faltando" | "";

// Status é derivado, nunca guardado: 'feito' quando o ano corrente já foi
// reconhecido; senão compara mês/dia do aniversário com a data atual — hoje
// ainda conta como 'faltando' até alguém marcar 'Feito' (regra confirmada
// com o usuário).
export function resolveBirthdayStatus(
  birthDate: string,
  birthdayAcknowledgedYear: number,
  today: { year: number; month: number; day: number },
): BirthdayStatus {
  if (!BIRTH_DATE_PATTERN.test(birthDate)) return "";
  if (birthdayAcknowledgedYear === today.year) return "feito";
  const month = Number(birthDate.slice(5, 7));
  const day = Number(birthDate.slice(8, 10));
  if (month < today.month || (month === today.month && day < today.day)) return "passou";
  return "faltando";
}

export function saoPauloToday(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}
