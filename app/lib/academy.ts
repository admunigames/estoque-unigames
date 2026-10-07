// Unigames Academy — integração SOMENTE LEITURA (catalog.read, people.read,
// progress.read) com https://unigames-academy.claudinhooo.chatgpt.site,
// base /api/integrations/v1, chave em Authorization: Bearer (segredo
// ACADEMY_API_KEY do Worker — nunca no front). A API não entrega o conteúdo
// das aulas nem deixa marcar conclusão: a tela mostra trilhas e progresso e
// abre a própria Academy para fazer a aula. Funções puras, sem I/O.

export type AcademyLesson = {
  id: string;
  title: string;
  summary: string;
  durationMinutes: number;
  trackId: string;
};

export type AcademyTrack = {
  id: string;
  title: string;
  description: string;
  audience: string;
  level: string;
  kind: string;
  outcome: string;
  lessonIds: string[];
};

export type AcademyCatalog = {
  tracks: AcademyTrack[];
  lessons: AcademyLesson[];
  journeyDays: { day: number; title: string; lessonIds: string[] }[];
};

export type AcademyPerson = {
  id: string;
  name: string;
  username: string;
  store: string;
  role: string;
  accessActive: boolean;
  startedAt: string;
  lastAccessAt: string;
  levelNumber: number;
  levelName: string;
  xp: number;
  completedLessons: number;
  approvedDays: number;
};

type Raw = Record<string, unknown>;

const text = (value: unknown, max = 400) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.map(obj) : []);

export function normalizeCatalog(body: unknown): AcademyCatalog {
  const root = obj(body);
  const lessons = list(root.lessons).map((row) => ({
    id: text(row.id, 120),
    title: text(row.title, 200),
    summary: text(row.summary),
    durationMinutes: num(row.durationMinutes),
    trackId: text(row.trackId, 120),
  })).filter((row) => row.id);
  const tracks = list(root.tracks).map((row) => ({
    id: text(row.id, 120),
    title: text(row.title, 200),
    description: text(row.description),
    audience: text(row.audience, 80),
    level: text(row.level, 80),
    kind: text(row.kind, 40),
    outcome: text(row.outcome),
    lessonIds: Array.isArray(row.lessonIds) ? row.lessonIds.map((id) => text(id, 120)).filter(Boolean) : [],
  })).filter((row) => row.id);
  // Trilha sem lessonIds: usa as aulas que apontam para ela (trackId).
  for (const track of tracks) {
    if (!track.lessonIds.length) track.lessonIds = lessons.filter((lesson) => lesson.trackId === track.id).map((lesson) => lesson.id);
  }
  const journeyDays = list(root.journeyDays).map((row) => ({
    day: num(row.day),
    title: text(row.title, 200),
    lessonIds: list(row.lessons).map((lesson) => text(lesson.id, 120)).filter(Boolean),
  }));
  // As aulas da jornada (ex.: "j1-cultura") NÃO vêm em `lessons`, só dentro
  // de journeyDays[].lessons — sem isso a trilha da jornada mostraria códigos
  // no lugar dos títulos e duração vazia.
  const known = new Set(lessons.map((lesson) => lesson.id));
  const journeyTrack = tracks.find((track) => track.kind === "journey");
  for (const day of list(root.journeyDays)) {
    for (const row of list(day.lessons)) {
      const id = text(row.id, 120);
      if (!id || known.has(id)) continue;
      known.add(id);
      lessons.push({ id, title: text(row.title, 200) || id, summary: "", durationMinutes: num(row.durationMinutes), trackId: journeyTrack?.id ?? "" });
    }
  }
  return { tracks, lessons, journeyDays };
}

export function normalizePerson(row: Raw): AcademyPerson {
  const level = obj(row.level);
  const journey = obj(row.journey);
  return {
    id: text(row.id, 120),
    name: text(row.name, 160),
    username: text(row.username, 120),
    store: text(row.store, 120),
    role: text(row.role, 80),
    accessActive: row.accessActive !== false,
    startedAt: text(row.startedAt, 40),
    lastAccessAt: text(row.lastAccessAt, 40),
    levelNumber: num(level.number),
    levelName: text(level.name, 80),
    xp: num(level.xp),
    completedLessons: num(journey.completedLessons),
    approvedDays: num(journey.approvedDays),
  };
}

export type AcademyProgress = {
  levelNumber: number;
  levelName: string;
  xp: number;
  levelProgress: number;
  xpToNext: number;
  completed: { lessonId: string; completedAt: string }[];
  journeySteps: { lessonId: string; step: number; updatedAt: string }[];
  certificates: Raw[];
  assessments: Raw[];
};

export function normalizeProgress(body: unknown): AcademyProgress {
  const root = obj(body);
  const level = obj(root.level);
  const journey = obj(root.journey);
  return {
    levelNumber: num(level.number),
    levelName: text(level.name, 80),
    xp: num(level.xp),
    levelProgress: num(level.progress),
    xpToNext: num(level.xpToNext),
    completed: list(root.completedLessons)
      .map((row) => ({ lessonId: text(row.lessonId, 120), completedAt: text(row.completedAt, 40) }))
      .filter((row) => row.lessonId),
    journeySteps: list(journey.lessons)
      .map((row) => ({ lessonId: text(row.lessonId, 120), step: num(row.step), updatedAt: text(row.updatedAt, 40) }))
      .filter((row) => row.lessonId),
    // Formato ainda não visto (vieram vazios): repassados como vieram, cortados.
    certificates: list(root.certificates).slice(0, 50),
    assessments: list(root.assessments).slice(0, 50),
  };
}

/** Progresso de cada trilha: aulas concluídas ÷ aulas da trilha. */
export function trackProgress(catalog: AcademyCatalog, completedLessonIds: Iterable<string>) {
  const done = new Set(completedLessonIds);
  return catalog.tracks.map((track) => {
    const total = track.lessonIds.length;
    const completed = track.lessonIds.filter((id) => done.has(id)).length;
    return { trackId: track.id, completed, total, percent: total ? Math.round((completed / total) * 100) : 0 };
  });
}

/** Maiúsculo, sem acento, sem pontuação, espaços simples. */
export function normalizeKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Participante da Academy de um login: o vínculo manual manda; sem ele,
 * casa pelo usuário (username) e, se não houver, pelo nome completo — só
 * quando o casamento é ÚNICO (dois homônimos = sem vínculo automático).
 */
export function matchParticipant(
  people: AcademyPerson[],
  user: { id: string; username: string; displayName: string },
  manualLinks: Record<string, string>,
): AcademyPerson | null {
  const manual = manualLinks[user.id];
  if (manual) return people.find((person) => person.id === manual) ?? null;
  const taken = new Set(Object.values(manualLinks));
  const free = people.filter((person) => !taken.has(person.id));
  const unique = (matches: AcademyPerson[]) => (matches.length === 1 ? matches[0] : null);
  const username = normalizeKey(user.username);
  if (username) {
    const byUser = unique(free.filter((person) => normalizeKey(person.username) === username));
    if (byUser) return byUser;
  }
  const name = normalizeKey(user.displayName);
  if (!name) return null;
  return unique(free.filter((person) => normalizeKey(person.name) === name));
}

/**
 * Loja da Academy (texto livre) × nome da loja do cadastro. Só igualdade
 * normalizada: "contém" casaria "RIOMAR RECIFE" com RIOMAR e com RECIFE.
 */
export function storeMatches(academyStore: string, companyName: string): boolean {
  const a = normalizeKey(academyStore);
  return Boolean(a) && a === normalizeKey(companyName);
}
