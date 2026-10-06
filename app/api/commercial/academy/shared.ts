import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  matchParticipant,
  normalizeCatalog,
  normalizePerson,
  normalizeProgress,
  storeMatches,
  type AcademyCatalog,
  type AcademyPerson,
} from "../../../lib/academy";
import {
  canManageCommercialGoals,
  commercialScope,
  identity,
  jsonResponse,
  linkedEmployeeIds,
  loadCompanyNames,
  type Database,
  type Identity,
} from "../shared";

// Cliente SOMENTE LEITURA da API da Unigames Academy (ver app/lib/academy.ts).
// A chave vive no segredo ACADEMY_API_KEY do Worker e só é usada aqui, no
// servidor. Catálogo e lista de pessoas ficam num cache curto por isolate.

export const ACADEMY_SITE_URL = "https://unigames-academy.claudinhooo.chatgpt.site/";
const API_BASE = "https://unigames-academy.claudinhooo.chatgpt.site/api/integrations/v1";
const LINKS_KEY = "commercial_academy_links";
const CATALOG_TTL_MS = 5 * 60_000;
const PEOPLE_TTL_MS = 2 * 60_000;
const MAX_PEOPLE_PAGES = 10; // 100 por página → até 1.000 pessoas

export class AcademyError extends Error {}

export function academyConfigured() {
  return Boolean(process.env.ACADEMY_API_KEY?.trim());
}

async function academyGet(path: string): Promise<unknown> {
  const key = process.env.ACADEMY_API_KEY?.trim();
  if (!key) throw new AcademyError("INTEGRAÇÃO COM A ACADEMY NÃO CONFIGURADA.");
  const response = await fetch(API_BASE + path, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (response.status === 401 || response.status === 403) {
    throw new AcademyError("A CHAVE DA ACADEMY FOI RECUSADA (VENCIDA OU REVOGADA).");
  }
  if (!response.ok) throw new AcademyError("A ACADEMY NÃO RESPONDEU AGORA. TENTE DE NOVO EM INSTANTES.");
  return response.json();
}

let catalogCache: { at: number; value: AcademyCatalog } | null = null;
let peopleCache: { at: number; value: AcademyPerson[] } | null = null;

export async function loadCatalog(): Promise<AcademyCatalog> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
  const value = normalizeCatalog(await academyGet("/catalog"));
  catalogCache = { at: Date.now(), value };
  return value;
}

export async function loadPeople(): Promise<AcademyPerson[]> {
  if (peopleCache && Date.now() - peopleCache.at < PEOPLE_TTL_MS) return peopleCache.value;
  const people: AcademyPerson[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PEOPLE_PAGES; page += 1) {
    const body = (await academyGet(`/people?limit=100&offset=${offset}`)) as {
      data?: unknown;
      pagination?: { nextOffset?: unknown };
    };
    const rows = Array.isArray(body?.data) ? body.data : [];
    people.push(...rows.map((row) => normalizePerson(row as Record<string, unknown>)).filter((person) => person.id));
    const next = Number(body?.pagination?.nextOffset);
    if (!rows.length || !Number.isFinite(next) || next <= offset) break;
    offset = next;
  }
  peopleCache = { at: Date.now(), value: people };
  return people;
}

export async function loadProgress(participantId: string) {
  return normalizeProgress(await academyGet(`/progress?participantId=${encodeURIComponent(participantId)}`));
}

/** Vínculos manuais { appUserId: participantId }. */
export async function loadLinks(database: Database): Promise<Record<string, string>> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key=?1")
    .bind(LINKS_KEY)
    .first<{ value: string }>();
  try {
    const parsed = row?.value ? JSON.parse(row.value) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1])),
    );
  } catch {
    return {};
  }
}

export async function saveLinks(database: Database, links: Record<string, string>) {
  await database
    .prepare(
      `INSERT INTO shared_state (state_key, value_json, version, updated_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(state_key) DO UPDATE SET
         value_json = excluded.value_json,
         version = shared_state.version + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(LINKS_KEY, JSON.stringify(links), new Date().toISOString())
    .run();
}

/** Gestor do treinamento: cadastra metas e NÃO é conta de vendedor. */
export async function canManageAcademyTeam(database: Database, actor: Identity) {
  if (!canManageCommercialGoals(actor)) return false;
  return actor.role === "admin" || (await linkedEmployeeIds(database, actor.id)).length === 0;
}

export type AppUserRow = { id: string; username: string; displayName: string; companyId: string; permissions: string; role: string };

export async function loadAppUser(database: Database, id: string) {
  return database
    .prepare(
      `SELECT id, username, display_name AS displayName, COALESCE(company_id, '') AS companyId,
              permissions_json AS permissions, role
       FROM app_users WHERE id=?1`,
    )
    .bind(id)
    .first<AppUserRow>();
}

/** Logins ativos com acesso ao Comercial (candidatos ao vínculo). */
export async function loadCommercialUsers(database: Database): Promise<AppUserRow[]> {
  const result = await database
    .prepare(
      `SELECT id, username, display_name AS displayName, COALESCE(company_id, '') AS companyId,
              permissions_json AS permissions, role
       FROM app_users WHERE active=1 ORDER BY display_name ASC`,
    )
    .all<AppUserRow>();
  return (result.results ?? []).filter((user) => {
    if (user.role === "admin") return false;
    try {
      const permissions = JSON.parse(user.permissions || "[]");
      return Array.isArray(permissions) && permissions.some((p) => typeof p === "string" && (p === "comercial" || p.startsWith("comercial:")));
    } catch {
      return false;
    }
  });
}

export type TeamScope = { allStores: boolean; companyId: string };

/**
 * Pessoas da Academy e logins que o gestor enxerga: todas as lojas, ou só a
 * loja dele (loja da Academy casada pelo nome da loja do cadastro).
 */
export async function scopedTeam(database: Database, scope: TeamScope) {
  const [people, users, links, companyNames] = await Promise.all([
    loadPeople(),
    loadCommercialUsers(database),
    loadLinks(database),
    loadCompanyNames(database),
  ]);
  const ownStoreName = scope.allStores ? "" : companyNames.get(scope.companyId) || "";
  const visiblePeople = scope.allStores ? people : people.filter((person) => storeMatches(person.store, ownStoreName));
  const visibleUsers = scope.allStores ? users : users.filter((user) => user.companyId === scope.companyId);
  // Quem está ligado a quem (manual ou automático): mostra na tela e impede
  // o mesmo participante em dois logins.
  const userByParticipant = new Map<string, AppUserRow & { manual: boolean }>();
  for (const user of users) {
    const match = matchParticipant(people, { id: user.id, username: user.username, displayName: user.displayName }, links);
    if (match && !userByParticipant.has(match.id)) userByParticipant.set(match.id, { ...user, manual: Boolean(links[user.id]) });
  }
  return { people: visiblePeople, users: visibleUsers, userByParticipant, links, companyNames };
}

/** Porteiro das rotas de equipe: gestor do treinamento, com escopo e chave. */
export async function teamGuard(
  request: Request,
): Promise<Response | { actor: Identity; scope: TeamScope; database: Database }> {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const database = await getD1();
  if (!(await canManageAcademyTeam(database, actor))) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER O TREINAMENTO DA EQUIPE." }, 403);
  }
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  if (!academyConfigured()) return jsonResponse({ error: "INTEGRAÇÃO COM A ACADEMY NÃO CONFIGURADA." }, 503);
  return { actor, scope, database };
}
