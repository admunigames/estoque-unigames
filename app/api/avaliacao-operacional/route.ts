import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { hasCompany } from "../../lib/access-scope";
import { recifeDate } from "../../lib/ordens-servico";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";

// Avaliação Operacional (permissões avaliacao_operacional:view/create/edit/
// delete). Situações por unidade com peso 1–5; total do mês = soma dos pesos;
// a(s) unidade(s) com o MENOR total (0 inclusive, empate = todas) são LOJA
// PREMIUM. Login sem loja (com a permissão) ou admin vê e age em todas as
// unidades; login com loja só na própria (sem posição nem dados das outras).
// O mês continua editável depois de acabar (decisão do usuário, 11/11/2026).
//   GET ?month=AAAA-MM                       → {month, units, weights, ranking, items, can}
//   POST   {unit, eventDate, description, weight}      (create)
//   PATCH  {id, unit, eventDate, description, weight}  (edit)
//   DELETE {id}                                        (delete; deleted=1)

type Actor = ReturnType<typeof identity>;
type Row = { id: string; unit: string; eventDate: string; description: string; weight: number };

// Lista fixa (vigência mensal). companyId liga o login de loja à unidade;
// PNWS = NORTH WAY no cadastro de lojas. COMERCIAL/ADMINISTRATIVO não têm loja.
const UNITS = [
  { name: "GUARARAPES", companyId: "cmrvhi8917bge4" },
  { name: "RECIFE", companyId: "cmrvhi891wn6mr" },
  { name: "RIOMAR", companyId: "cmrvhi891w5qk7" },
  { name: "TACARUNA", companyId: "cmrvhi891vkkx6" },
  { name: "PATTEO", companyId: "cmrvhi891tlmkf" },
  { name: "PNWS", companyId: "cmrvhi891nix2b" },
  { name: "QUIOSQUE P.A", companyId: "cmrvhi891w9tc1" },
  { name: "ASSISTÊNCIA", companyId: "cmsf6alzkcw4wk" },
  { name: "COMERCIAL", companyId: "" },
  { name: "ADMINISTRATIVO", companyId: "" },
];

const WEIGHTS = [
  { weight: 1, label: "ERRO LEVE" },
  { weight: 2, label: "ERRO OPERACIONAL PEQUENO" },
  { weight: 3, label: "ERRO MODERADO" },
  { weight: 4, label: "ERRO GRAVE" },
  { weight: 5, label: "ERRO CRÍTICO OU RECORRENTE" },
];

const ACTIONS = ["view", "create", "edit", "delete"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const NOT_FOUND = "SITUAÇÃO NÃO ENCONTRADA.";
const SELECT = `SELECT id, unit, event_date AS eventDate, description, weight, created_by_name AS createdByName,
  created_at AS createdAt, updated_by_name AS updatedByName, updated_at AS updatedAt FROM ops_evaluations`;

const can = (actor: Actor, action: string) =>
  actor.role === "admin" || actor.permissions.includes(`avaliacao_operacional:${action}`);

/** Unidades que o ator vê/age: todas, ou só a da loja do login (nenhuma se a loja não for avaliada). */
function allowedUnits(actor: Actor): string[] {
  if (actor.role === "admin" || !hasCompany(actor.companyId)) return UNITS.map((unit) => unit.name);
  return UNITS.filter((unit) => unit.companyId === actor.companyId).map((unit) => unit.name);
}

function guard(request: Request, action: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  const allowed = action === "view" ? ACTIONS.some((item) => can(actor, item)) : can(actor, action);
  if (!allowed) return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA A AVALIAÇÃO OPERACIONAL." }, 403) };
  if (request.method !== "GET" && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor, units: allowedUnits(actor) };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const payload = await request.json().catch(() => null);
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function fields(payload: Record<string, unknown>, units: string[]) {
  const unit = safeText(payload.unit, 40).toLocaleUpperCase("pt-BR");
  const eventDate = safeText(payload.eventDate, 10);
  const description = safeText(payload.description, 1000).toLocaleUpperCase("pt-BR");
  const weight = Number(payload.weight);
  if (!units.includes(unit)) return { error: "SELECIONE A UNIDADE." };
  if (!DATE.test(eventDate) || eventDate > recifeDate()) return { error: "INFORME A DATA (NÃO PODE SER FUTURA)." };
  if (!description) return { error: "INFORME O QUE HOUVE." };
  if (!Number.isInteger(weight) || weight < 1 || weight > 5) return { error: "ESCOLHA O PESO (1 A 5)." };
  return { unit, eventDate, description, weight };
}

/** Situação visível ao ator (fora do escopo responde o mesmo 404). */
async function findRow(database: D1Database, id: string, units: string[]) {
  const row = id ? await database.prepare(`${SELECT} WHERE id=?1 AND deleted=0`).bind(id).first<Row>() : null;
  return row && units.includes(row.unit) ? row : null;
}

const nextMonth = (month: string) => {
  const [year, mm] = month.split("-").map(Number);
  return mm === 12 ? `${year + 1}-01` : `${year}-${String(mm + 1).padStart(2, "0")}`;
};

/** Total por unidade (todas as unidades, mesmo com 0), do menor para o maior; menor total = PREMIUM. */
function buildRanking(rows: { unit: string; weight: number }[]) {
  const ranking = UNITS.map(({ name }) => {
    const own = rows.filter((row) => row.unit === name);
    const byWeight = Object.fromEntries(WEIGHTS.map(({ weight }) => [weight, own.filter((row) => Number(row.weight) === weight).length]));
    return { unit: name, total: own.reduce((sum, row) => sum + Number(row.weight), 0), count: own.length, byWeight, premium: false };
  }).sort((a, b) => a.total - b.total);
  for (const row of ranking) row.premium = row.total === ranking[0].total;
  return ranking;
}

export async function GET(request: Request) {
  const checked = guard(request, "view");
  if ("error" in checked) return checked.error;
  const { actor, units } = checked;
  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH.test(requested) ? requested : recifeDate().slice(0, 7);
  const database = await getD1();
  // Uma consulta: o ranking precisa do mês de todas as unidades (PREMIUM), mesmo para a loja.
  const { results } = await database
    .prepare(`${SELECT} WHERE deleted=0 AND event_date>=?1 AND event_date<?2 ORDER BY event_date, created_at`)
    .bind(`${month}-01`, `${nextMonth(month)}-01`)
    .all<Row>();
  const rows = results ?? [];
  return jsonResponse({
    month,
    today: recifeDate(),
    allUnits: units.length === UNITS.length,
    units,
    weights: WEIGHTS,
    ranking: buildRanking(rows).filter((row) => units.includes(row.unit)),
    items: rows.filter((row) => units.includes(row.unit)),
    can: Object.fromEntries(ACTIONS.map((action) => [action, can(actor, action) && units.length > 0])),
  });
}

export async function POST(request: Request) {
  const checked = guard(request, "create");
  if ("error" in checked) return checked.error;
  const { actor, units } = checked;
  const parsed = fields(await body(request), units);
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
  const id = crypto.randomUUID();
  await (await getD1())
    .prepare(`INSERT INTO ops_evaluations (id, unit, event_date, description, weight, created_by, created_by_name, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(id, parsed.unit, parsed.eventDate, parsed.description, parsed.weight, actor.id, actor.displayName || actor.id, new Date().toISOString())
    .run();
  return jsonResponse({ id }, 201);
}

export async function PATCH(request: Request) {
  const checked = guard(request, "edit");
  if ("error" in checked) return checked.error;
  const { actor, units } = checked;
  const payload = await body(request);
  const database = await getD1();
  const row = await findRow(database, safeText(payload.id, 80), units);
  if (!row) return jsonResponse({ error: NOT_FOUND }, 404);
  const parsed = fields(payload, units);
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
  await database
    .prepare(`UPDATE ops_evaluations SET unit=?2, event_date=?3, description=?4, weight=?5, updated_by=?6, updated_by_name=?7, updated_at=?8
      WHERE id=?1`)
    .bind(row.id, parsed.unit, parsed.eventDate, parsed.description, parsed.weight, actor.id, actor.displayName || actor.id, new Date().toISOString())
    .run();
  return jsonResponse({ ok: true });
}

export async function DELETE(request: Request) {
  const checked = guard(request, "delete");
  if ("error" in checked) return checked.error;
  const { actor, units } = checked;
  const database = await getD1();
  const row = await findRow(database, safeText((await body(request)).id, 80), units);
  if (!row) return jsonResponse({ error: NOT_FOUND }, 404);
  await database
    .prepare("UPDATE ops_evaluations SET deleted=1, updated_by=?2, updated_by_name=?3, updated_at=?4 WHERE id=?1")
    .bind(row.id, actor.id, actor.displayName || actor.id, new Date().toISOString())
    .run();
  return jsonResponse({ ok: true });
}
