import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Comercial > Treinamento (Unigames Academy, integração só leitura). Rotas
// reais sobre SQLite, com a API da Academy SIMULADA (fetch falso) — nenhum
// teste chama a Academy de verdade nem usa a chave real.

const lib = await import("../app/lib/academy.ts");

const CATALOG = {
  apiVersion: "1",
  tracks: [
    { id: "t-vendas", title: "Vendas", description: "Atendimento", audience: "Todos", level: "Inicial", kind: "track", lessonIds: ["l1", "l2"] },
    { id: "t-sem-ids", title: "Operação", kind: "track", lessonIds: [] },
  ],
  lessons: [
    { id: "l1", title: "Abordagem", durationMinutes: 10, trackId: "t-vendas" },
    { id: "l2", title: "Fechamento", durationMinutes: 15, trackId: "t-vendas" },
    { id: "l3", title: "Abertura da loja", durationMinutes: 5, trackId: "t-sem-ids" },
  ],
  courses: [],
  journeyDays: [{ day: 1, title: "Cultura", lessons: [{ id: "l1", title: "Abordagem" }] }],
};
const PEOPLE = [
  { id: "p-ana", name: "Ana Souza", username: "ana.souza", store: "LOJA ALFA", role: "Vendedor", level: { number: 2, name: "Bronze", xp: 120 }, journey: { completedLessons: 1, approvedDays: 1 } },
  { id: "p-bruno", name: "Bruno Lima", username: "bruno", store: "LOJA ALFA", level: { number: 1, name: "Inicial", xp: 0 }, journey: { completedLessons: 0, approvedDays: 0 } },
  { id: "p-carla", name: "Carla Dias", username: "carla", store: "Loja Beta", level: { number: 1, name: "Inicial", xp: 0 }, journey: { completedLessons: 0, approvedDays: 0 } },
];
const PROGRESS = {
  "p-ana": { participant: { id: "p-ana" }, level: { number: 2, name: "Bronze", xp: 120, progress: 40, xpToNext: 80 }, completedLessons: [{ lessonId: "l1", completedAt: "2026-10-01T12:00:00Z" }], journey: { lessons: [], reviews: [] }, certificates: [], assessments: [] },
};

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  calls.push({ path: target.pathname, auth: init.headers?.Authorization });
  if (init.headers?.Authorization !== "Bearer uak_teste") return new Response("{}", { status: 401 });
  const path = target.pathname.replace("/api/integrations/v1", "");
  if (path === "/catalog") return Response.json(CATALOG);
  if (path === "/people") {
    const offset = Number(target.searchParams.get("offset"));
    // Duas páginas: 2 pessoas e depois 1, para testar a paginação.
    const page = offset === 0 ? PEOPLE.slice(0, 2) : PEOPLE.slice(2);
    return Response.json({ data: page, pagination: { limit: 100, offset, total: 3, nextOffset: offset === 0 ? 2 : null } });
  }
  if (path === "/progress") {
    const body = PROGRESS[target.searchParams.get("participantId")];
    return body ? Response.json(body) : Response.json({ completedLessons: [], level: {}, journey: {} });
  }
  return new Response("{}", { status: 404 });
};

const db = await setupRouteDb(["shared_state", "app_users", "hr_employees"]);
const me = await import("../app/api/commercial/academy/me/route.ts");
const team = await import("../app/api/commercial/academy/team/route.ts");
const links = await import("../app/api/commercial/academy/links/route.ts");

const STORE_A = "clojaalfa1";
const STORE_B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: STORE_A, name: "LOJA ALFA" }, { id: STORE_B, name: "LOJA BETA" }]),
});
const user = (id, username, displayName, companyId, permissions) =>
  db.insert("app_users", {
    id, username, display_name: displayName, email: "", password_hash: "x", password_salt: "x", role: "user",
    access_group: "custom", permissions_json: JSON.stringify(permissions), company_id: companyId, active: 1,
  });
user("u-ana", "ana.souza", "Ana", STORE_A, ["comercial:dashboard"]);
user("u-bruno", "bruno.l", "Bruno Lima", STORE_A, ["comercial:dashboard"]);
user("u-carla", "carlad", "Carla D.", STORE_B, ["comercial:dashboard"]);
user("u-estoque", "estoque", "Estoque", STORE_A, ["stock:view"]);

const ANA = { id: "u-ana", companyId: STORE_A, permissions: ["comercial:dashboard"] };
const CARLA = { id: "u-carla", companyId: STORE_B, permissions: ["comercial:dashboard"] };
const GESTOR_GERAL = { id: "u-gestor", permissions: ["comercial:goals", "comercial:dashboard"] };
const GESTOR_A = { id: "u-gestor-a", companyId: STORE_A, permissions: ["comercial:goals"] };
const ESTOQUE = { id: "u-estoque", companyId: STORE_A, permissions: ["stock:view"] };

const getMe = (actor) => callRoute(me.GET, actor, "GET", "/api/commercial/academy/me");
const getTeam = (actor, query = "") => callRoute(team.GET, actor, "GET", "/api/commercial/academy/team" + query);
const putLink = (actor, body) => callRoute(links.PUT, actor, "PUT", "/api/commercial/academy/links", body);

test("lib: catálogo normalizado, trilha sem lessonIds usa trackId, progresso por trilha", () => {
  const catalog = lib.normalizeCatalog(CATALOG);
  assert.deepEqual(catalog.tracks.find((t) => t.id === "t-sem-ids").lessonIds, ["l3"]);
  assert.deepEqual(catalog.journeyDays[0].lessonIds, ["l1"]);
  const progress = lib.trackProgress(catalog, ["l1"]);
  assert.deepEqual(progress.find((row) => row.trackId === "t-vendas"), { trackId: "t-vendas", completed: 1, total: 2, percent: 50 });
});

test("lib: vínculo manual manda; automático por usuário, depois por nome, só se único", () => {
  const people = PEOPLE.map(lib.normalizePerson);
  assert.equal(lib.matchParticipant(people, { id: "u1", username: "ANA.SOUZA", displayName: "x" }, {}).id, "p-ana");
  assert.equal(lib.matchParticipant(people, { id: "u2", username: "outro", displayName: "bruno líma" }, {}).id, "p-bruno");
  assert.equal(lib.matchParticipant(people, { id: "u3", username: "z", displayName: "Ninguém" }, {}), null);
  assert.equal(lib.matchParticipant(people, { id: "u3", username: "z", displayName: "Ninguém" }, { u3: "p-carla" }).id, "p-carla");
  // Participante vinculado à mão a outro login não casa no automático.
  assert.equal(lib.matchParticipant(people, { id: "u1", username: "ana.souza", displayName: "" }, { u9: "p-ana" }), null);
  const twins = [...people, lib.normalizePerson({ id: "p-ana2", name: "Bruno Lima", username: "b2" })];
  assert.equal(lib.matchParticipant(twins, { id: "u2", username: "", displayName: "Bruno Lima" }, {}), null);
  assert.equal(lib.storeMatches("Loja Beta", "LOJA BETA"), true);
  assert.equal(lib.storeMatches("RIOMAR RECIFE", "RECIFE"), false);
});

test("me: sem a chave configurada responde configured:false", async () => {
  delete process.env.ACADEMY_API_KEY;
  const response = await getMe(ANA);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, false);
});

test("me: vendedor vê catálogo e o próprio progresso (vínculo automático por usuário), chave só no servidor", async () => {
  process.env.ACADEMY_API_KEY = "uak_teste";
  const response = await getMe(ANA);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.equal(body.participant.id, "p-ana");
  assert.equal(body.canManageTeam, false);
  assert.deepEqual(body.progress.completed.map((row) => row.lessonId), ["l1"]);
  assert.equal(body.tracks.find((row) => row.trackId === "t-vendas").percent, 50);
  assert.ok(!JSON.stringify(body).includes("uak_teste"), "a chave nunca vai para o front");
  assert.ok(calls.every((call) => call.auth === "Bearer uak_teste"));
  // Paginação: as 3 pessoas foram lidas em 2 páginas.
  assert.ok(calls.some((call) => call.path.endsWith("/people")));
});

test("me: sem permissão comercial = 403; sem vínculo = participant null", async () => {
  assert.equal((await getMe(ESTOQUE)).status, 403);
  const body = await (await getMe(CARLA)).json();
  assert.equal(body.participant, null);
});

test("team: só gestor (comercial:goals); gestor de loja só vê a própria loja; vendedor 403", async () => {
  assert.equal((await getTeam(ANA)).status, 403);
  const all = await (await getTeam(GESTOR_GERAL)).json();
  assert.deepEqual(all.people.map((p) => p.id).sort(), ["p-ana", "p-bruno", "p-carla"]);
  assert.equal(all.people.find((p) => p.id === "p-ana").linkedUser.id, "u-ana");
  assert.equal(all.people.find((p) => p.id === "p-bruno").linkedUser.id, "u-bruno", "casou pelo nome");
  assert.ok(!all.users.some((u) => u.id === "u-estoque"), "login sem Comercial não aparece para vincular");
  const own = await (await getTeam(GESTOR_A)).json();
  assert.deepEqual(own.people.map((p) => p.id).sort(), ["p-ana", "p-bruno"]);
  assert.ok(own.users.every((u) => u.id !== "u-carla"));
  // Progresso de alguém fora do escopo = 404.
  assert.equal((await getTeam(GESTOR_A, "?participantId=p-carla")).status, 404);
  const detail = await (await getTeam(GESTOR_A, "?participantId=p-ana")).json();
  assert.equal(detail.tracks.find((row) => row.trackId === "t-vendas").completed, 1);
});

test("links: gestor vincula à mão, tira de quem tinha e desfaz; fora do escopo 404", async () => {
  assert.equal((await putLink(ANA, { userId: "u-carla", participantId: "p-carla" })).status, 403);
  assert.equal((await putLink(GESTOR_A, { userId: "u-carla", participantId: "p-carla" })).status, 404);
  assert.equal((await putLink(GESTOR_GERAL, { userId: "u-carla", participantId: "p-carla" })).status, 200);
  assert.equal((await (await getMe(CARLA)).json()).participant.id, "p-carla");
  // Passa p-carla para a Ana: a Carla perde o vínculo manual.
  assert.equal((await putLink(GESTOR_GERAL, { userId: "u-ana", participantId: "p-carla" })).status, 200);
  const saved = JSON.parse(db.sqlite.prepare("SELECT value_json FROM shared_state WHERE state_key='commercial_academy_links'").get().value_json);
  assert.deepEqual(saved, { "u-ana": "p-carla" });
  // Desfaz: volta ao automático (Ana casa de novo pelo usuário).
  assert.equal((await putLink(GESTOR_GERAL, { userId: "u-ana", participantId: "" })).status, 200);
  assert.equal((await (await getMe(ANA)).json()).participant.id, "p-ana");
  assert.equal((await putLink(GESTOR_GERAL, { userId: "u-ana", participantId: "p-nao-existe" })).status, 404);
});

test("chave recusada pela Academy vira mensagem clara (502), sem 500", async () => {
  process.env.ACADEMY_API_KEY = "uak_vencida";
  // Força nova leitura: o cache curto do isolate não vale para o teste.
  const response = await callRoute(team.GET, GESTOR_GERAL, "GET", "/api/commercial/academy/team?participantId=p-ana");
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /RECUSADA/);
  process.env.ACADEMY_API_KEY = "uak_teste";
});
