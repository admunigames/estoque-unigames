// RH — regras puras (sem banco) do pacote de out/2026: pendências do
// Recrutamento, desligamento, vencimento do ASO, aniversário na véspera,
// indicadores do Dashboard e progresso do Onboarding. Testadas em
// tests/hr-rh.test.mjs.

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Soma dias a AAAA-MM-DD (meio-dia UTC, sem efeito de fuso). */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Soma meses mantendo o dia; 31/01 + 1 mês = 28 ou 29/02 (último dia). */
export function addMonths(date: string, months: number): string {
  if (!DATE_RE.test(date)) return "";
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

/** Data de hoje no fuso de Recife (AAAA-MM-DD). */
export function recifeToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife" }).format(now);
}

// ---------------------------------------------------------------------------
// 1. Recrutamento — texto da pendência por status (configurável em hr_settings)
// ---------------------------------------------------------------------------

export const RECRUITMENT_STATUS_LABELS: Record<string, string> = {
  selecionado_entrevista: "SELECIONADO PARA ENTREVISTA",
  em_teste: "EM TESTE",
  em_treinamento: "EM TREINAMENTO",
  contratado: "CONTRATADO",
  integracao: "INTEGRAÇÃO",
  cancelado: "CANCELADO",
};

// '' = só aviso (push), sem tarefa.
export const RECRUITMENT_PENDING_DEFAULTS: Record<string, string> = {
  selecionado_entrevista: "PENDENTE DE ENTREVISTA",
  em_teste: "PENDENTE DE TESTE",
  em_treinamento: "PENDENTE DE TREINAMENTO",
  contratado: "PENDENTE DE ADMISSÃO/INTEGRAÇÃO",
  integracao: "PENDENTE DE INTEGRAÇÃO",
  cancelado: "",
};

export function recruitmentPendingTexts(saved: unknown): Record<string, string> {
  const source = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const texts: Record<string, string> = {};
  for (const [status, fallback] of Object.entries(RECRUITMENT_PENDING_DEFAULTS)) {
    texts[status] = typeof source[status] === "string" ? String(source[status]).trim().slice(0, 120) : fallback;
  }
  return texts;
}

/** Aviso da mudança de status: título do push e texto da tarefa ('' = sem tarefa). */
export function recruitmentNotice(
  fromStatus: string,
  toStatus: string,
  candidateName: string,
  storeName: string,
  texts: Record<string, string>,
) {
  const who = [candidateName, storeName].filter(Boolean).join(" — ");
  const from = RECRUITMENT_STATUS_LABELS[fromStatus] || fromStatus;
  const to = RECRUITMENT_STATUS_LABELS[toStatus] || toStatus;
  const pending = texts[toStatus] || "";
  return {
    title: `RECRUTAMENTO: ${from} → ${to}`,
    body: pending ? `${pending} — ${who}` : `${to} — ${who}`,
    taskText: pending ? `${pending} — ${who}` : "",
  };
}

// ---------------------------------------------------------------------------
// 3. Desligamento
// ---------------------------------------------------------------------------

export const TERMINATION_REASONS: Record<string, string> = {
  pedido_demissao: "PEDIDO DE DEMISSÃO",
  sem_justa_causa: "DISPENSA SEM JUSTA CAUSA",
  com_justa_causa: "DISPENSA COM JUSTA CAUSA",
  termino_contrato: "TÉRMINO DE CONTRATO/EXPERIÊNCIA",
  acordo: "ACORDO",
  outro: "OUTRO",
};

// Espelha o checklist admissional do Recrutamento (sistemas Pontti, iFood,
// Faceponto, PayJoy, plano odontológico) — cada um vira um item de saída.
export const TERMINATION_CHECKLIST: Record<string, string> = {
  aviso_previo: "AVISO PRÉVIO ASSINADO (TRABALHADO OU INDENIZADO)",
  aso_demissional: "EXAME DEMISSIONAL (ASO) REALIZADO",
  devolucao: "DEVOLUÇÃO DE UNIFORME, CRACHÁ, CHAVES E EQUIPAMENTOS (NOTEBOOK, CELULAR, CARTÃO CORPORATIVO)",
  acessos: "BLOQUEIO DO LOGIN DO SISTEMA, E-MAIL E WHATSAPP DA LOJA E RETIRADA DO VÍNCULO DE LOGIN",
  pontti_unigames: "INATIVADO NO SISTEMA UNIGAMES (PONTTI)",
  pontti_pa: "INATIVADO NO SISTEMA PA (PONTTI)",
  pontti_assistencia: "INATIVADO NO SISTEMA ASSISTÊNCIA (PONTTI)",
  ifood: "EXCLUÍDO DO IFOOD",
  faceponto: "EXCLUÍDO DO FACEPONTO",
  payjoy: "EXCLUÍDO DO PAYJOY",
  baixa_ctps: "BAIXA NA CARTEIRA DE TRABALHO (ESOCIAL) E RESCISÃO CALCULADA",
  pagamento: "PAGAMENTO DA RESCISÃO E GUIAS (FGTS/MULTA, SEGURO-DESEMPREGO)",
  pendencias: "CONFERÊNCIA DE PENDÊNCIAS (VALES, COMISSÕES, DEVOLUÇÕES, PONTO)",
  entrevista: "ENTREVISTA DE DESLIGAMENTO",
  beneficios: "EXCLUSÃO DO PLANO ODONTOLÓGICO/BENEFÍCIOS",
};

export type ChecklistEntry = { status: "feito" | "na" | ""; note: string };

/** Normaliza o checklist recebido: só itens conhecidos, status feito/na/''. */
export function normalizeChecklist(value: unknown): Record<string, ChecklistEntry> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result: Record<string, ChecklistEntry> = {};
  for (const item of Object.keys(TERMINATION_CHECKLIST)) {
    const raw = source[item] && typeof source[item] === "object" ? (source[item] as Record<string, unknown>) : {};
    const status = raw.status === "feito" || raw.status === "na" ? raw.status : "";
    result[item] = { status, note: typeof raw.note === "string" ? raw.note.trim().slice(0, 300) : "" };
  }
  return result;
}

/**
 * Quantos itens do checklist ainda não estão FEITO nem NÃO SE APLICA.
 * Rescisão anterior ao checklist (JSON vazio) não gera alerta: 0.
 */
export function checklistPendingCount(json: string): number {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(json || "{}");
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) return 0;
  return Object.values(normalizeChecklist(parsed)).filter((entry) => !entry.status).length;
}

/** Valida motivo do desligamento; devolve a mensagem de erro ou ''. */
export function terminationError(date: string, reason: string, reasonOther: string): string {
  if (!DATE_RE.test(date)) return "INFORME A DATA DO DESLIGAMENTO.";
  if (!TERMINATION_REASONS[reason]) return "INFORME O MOTIVO DO DESLIGAMENTO.";
  if (reason === "outro" && !reasonOther.trim()) return "DESCREVA O MOTIVO DO DESLIGAMENTO (OUTRO).";
  return "";
}

// ---------------------------------------------------------------------------
// 5. Exames — vencimento anual
// ---------------------------------------------------------------------------

export const ASO_VALIDITY_MONTHS = 12;

export function asoExpiry(examDate: string, informed = ""): string {
  return DATE_RE.test(informed) ? informed : addMonths(examDate, ASO_VALIDITY_MONTHS);
}

export type ExamSituation = "sem_exame" | "vencido" | "7" | "15" | "30" | "ok";

export function examSituation(expiryDate: string, today: string): ExamSituation {
  if (!DATE_RE.test(expiryDate)) return "sem_exame";
  const days = daysBetween(today, expiryDate);
  if (days < 0) return "vencido";
  if (days <= 7) return "7";
  if (days <= 15) return "15";
  if (days <= 30) return "30";
  return "ok";
}

/** Dias antes do vencimento em que o RH é avisado (push + tarefa). */
export const EXAM_ALERT_OFFSETS = [30, 7, 0];

// ---------------------------------------------------------------------------
// 6. Aniversário na véspera
// ---------------------------------------------------------------------------

/** Nascidos em AAAA-MM-DD fazem aniversário em `date`? 29/02 vira 28/02 em ano não bissexto. */
export function isBirthdayOn(birthDate: string, date: string): boolean {
  if (!DATE_RE.test(birthDate) || !DATE_RE.test(date)) return false;
  const monthDay = birthDate.slice(5);
  if (monthDay === date.slice(5)) return true;
  const year = Number(date.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return monthDay === "02-29" && !leap && date.slice(5) === "02-28";
}

// ---------------------------------------------------------------------------
// 4. Dashboard — turnover e contagens
// ---------------------------------------------------------------------------

export type DashEmployee = { id: string; admissionDate: string; status: string };
export type DashTermination = { employeeId: string; terminationDate: string };

function inRange(date: string, from: string, to: string) {
  return Boolean(date) && date >= from && date <= to;
}

/**
 * Ativo numa data: admitido até ela e sem desligamento (da admissão atual) até
 * ela. Inativo sem registro de desligamento não conta (data de saída desconhecida).
 */
export function activeOn(employee: DashEmployee, terminations: DashTermination[], date: string): boolean {
  if (employee.admissionDate && employee.admissionDate > date) return false;
  const ends = terminations.filter((item) =>
    item.employeeId === employee.id && item.terminationDate && item.terminationDate >= (employee.admissionDate || ""));
  if (ends.length) return ends.every((item) => item.terminationDate > date);
  return employee.status === "active";
}

export function peopleIndicators(
  employees: DashEmployee[],
  terminations: DashTermination[],
  from: string,
  to: string,
) {
  const admitted = employees.filter((employee) => inRange(employee.admissionDate, from, to)).length;
  const dismissed = terminations.filter((item) => inRange(item.terminationDate, from, to)).length;
  const activeStart = employees.filter((employee) => activeOn(employee, terminations, addDays(from, -1))).length;
  const activeEnd = employees.filter((employee) => activeOn(employee, terminations, to)).length;
  const averageActive = (activeStart + activeEnd) / 2;
  const turnover = averageActive > 0 ? Math.round((((admitted + dismissed) / 2) / averageActive) * 1000) / 10 : 0;
  return { admitted, dismissed, activeStart, activeEnd, averageActive, turnover };
}

export type DashCandidate = {
  status: string;
  interviewDate: string;
  interviewResult: string;
  createdAt: string;
};

export function recruitmentIndicators(candidates: DashCandidate[], from: string, to: string, today: string) {
  const inPeriod = candidates.filter((candidate) => inRange(candidate.interviewDate, from, to));
  const byStatus: Record<string, number> = Object.fromEntries(Object.keys(RECRUITMENT_STATUS_LABELS).map((status) => [status, 0]));
  for (const candidate of candidates) {
    if (inRange(candidate.interviewDate || String(candidate.createdAt || "").slice(0, 10), from, to)) {
      byStatus[candidate.status] = (byStatus[candidate.status] || 0) + 1;
    }
  }
  return {
    scheduled: inPeriod.length,
    interviewed: inPeriod.filter((candidate) => candidate.interviewResult || candidate.interviewDate <= today).length,
    approved: inPeriod.filter((candidate) => candidate.interviewResult === "aprovado").length,
    rejected: inPeriod.filter((candidate) => candidate.interviewResult === "reprovado").length,
    byStatus,
  };
}

/** Mesmo período no mês anterior (01–18/10 → 01–18/09; 31/10 → 30/09). */
export function previousPeriod(from: string, to: string) {
  return { from: addMonths(from, -1), to: addMonths(to, -1) };
}

// ---------------------------------------------------------------------------
// 8. Onboarding — progresso que só avança assistindo
// ---------------------------------------------------------------------------

/**
 * Novo total assistido: o player manda o ponto mais distante assistido sem
 * pular; o servidor só aceita o avanço que caberia no tempo real decorrido
 * desde o último registro (+ folga para velocidade 1,25x e atraso de rede).
 * ponytail: tempo pausado também conta como "decorrido" — o bloqueio de pular
 * fica no player; se precisar ser à prova de cliente adulterado, somar só os
 * intervalos entre batidas com o vídeo tocando.
 */
export function acceptWatched(previous: number, reported: number, elapsedSeconds: number, duration: number) {
  const allowed = previous + Math.max(0, elapsedSeconds) * 1.25 + 3;
  const next = Math.max(previous, Math.min(Math.floor(reported), Math.floor(allowed)));
  return duration > 0 ? Math.min(next, duration) : next;
}

export function videoCompleted(watched: number, duration: number) {
  return duration > 0 && watched >= duration - 1;
}

function normalizeRole(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
}

/** Vídeo vale para o colaborador: cargo contido no cargo dele ('' = todos) e loja ('' = todas). */
export function videoAppliesTo(
  video: { roleTitle: string; companyId: string; active: number },
  employee: { roleTitle: string; companyId: string },
) {
  if (!Number(video.active)) return false;
  if (video.companyId && video.companyId !== employee.companyId) return false;
  return !video.roleTitle || normalizeRole(employee.roleTitle).includes(normalizeRole(video.roleTitle));
}

// ---------------------------------------------------------------------------
// Recrutamento — pendências do checklist admissional (CONTRATADO)
// ---------------------------------------------------------------------------

/** Itens do checklist: 1 = feito, 2 = não se aplica, 0 = pendente. */
export const ADMISSION_CHECKLIST: Array<[string, string]> = [
  ["kitDelivered", "KIT ADMISSIONAL"],
  ["uniformSent", "FARDAS/CASACO"],
  ["system1Done", "SISTEMA UNIGAMES"],
  ["system2Done", "SISTEMA PA"],
  ["system3Done", "SISTEMA ASSISTÊNCIA"],
  ["ifoodDone", "IFOOD"],
  ["benefitsIncluded", "PLANILHA DE BENEFÍCIOS"],
  ["benefitsCalculated", "CÁLCULO DOS BENEFÍCIOS"],
  ["facepontoDone", "FACEPONTO"],
  ["payjoyDone", "PAYJOY"],
  ["birthdayListAdded", "CONTROLE DE ANIVERSÁRIO"],
  ["photoTaken", "FOTO"],
  ["asoRequested", "ASO"],
  ["shoppingRegistered", "SHOPPING FIXO"],
  ["dentalPlanIncluded", "PLANO ODONTOLÓGICO"],
  ["referencesChecked", "REFERÊNCIAS"],
  ["integrationMeetingDone", "REUNIÃO DE INTEGRAÇÃO"],
  ["integrationTermSigned", "TERMO DE INTEGRAÇÃO"],
];

/** 'sim'/true/1 → 1; 'na'/2 → 2 (não se aplica); resto → 0. */
export function checklistValue(value: unknown): number {
  if (value === "na" || value === 2 || value === "2") return 2;
  return value === true || value === "sim" || value === "true" || value === 1 || value === "1" ? 1 : 0;
}

export function admissionPending(candidate: Record<string, unknown>): string[] {
  return ADMISSION_CHECKLIST.filter(([field]) => !Number(candidate[field])).map(([, label]) => label);
}

/** Lembrete diário só para contratações recentes (evita cobrar histórico antigo). */
export const ADMISSION_REMINDER_DAYS = 45;
