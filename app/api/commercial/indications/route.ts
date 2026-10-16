import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  actorName,
  canManageCommercialIndications,
  commercialScope,
  employeeInScope,
  identity,
  indicationSummary,
  jsonResponse,
  loadCompanyNames,
  nonNegativeInt,
  safeText,
  sameOrigin,
  type Database,
  type Identity,
  type JsonMap,
} from "../shared";

// Aba INDICAÇÃO (comercial:indications) — SÓ CONTROLE: não gera comissão nem
// premiação e nada vai para o RH (nenhuma chamada a syncHrCommissions aqui).
// Login com loja vê e lança só a própria loja (commercialScope).
//   GET    ?month → lançamentos do mês (inclusive excluídos, com o histórico),
//                   totais por loja e por quem indicou, lojas e funcionários
//   POST   {date, companyId, employeeId | referrerName, customer, reference, amountCents, notes}
//   PUT    {id, ...mesmos campos}
//   DELETE ?id    → exclusão lógica (fica no histórico, sai dos totais)

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

type Row = {
  id: string; month: string; date: string; companyId: string; companyName: string; employeeId: string;
  referrerName: string; customer: string; reference: string; amountCents: number; notes: string;
  createdByName: string; createdAt: string; updatedByName: string; updatedAt: string;
  deletedAt: string; deletedByName: string; historyJson: string;
};

type HistoryEntry = { action: "CRIOU" | "EDITOU" | "EXCLUIU"; byName: string; at: string; changes: string[] };

const COLUMNS = `id, month, date, company_id AS companyId, company_name AS companyName, employee_id AS employeeId,
  referrer_name AS referrerName, customer, reference, amount_cents AS amountCents, notes,
  created_by_name AS createdByName, created_at AS createdAt, updated_by_name AS updatedByName,
  updated_at AS updatedAt, deleted_at AS deletedAt, deleted_by_name AS deletedByName, history_json AS historyJson`;

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManageCommercialIndications(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA A ABA INDICAÇÃO." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) {
    return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  }
  const scope = commercialScope(actor);
  if (!scope) return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  return { actor, scope };
}

function history(row: Pick<Row, "historyJson">): HistoryEntry[] {
  try {
    const parsed = JSON.parse(row.historyJson || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function brl(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function brDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

type Fields = Pick<Row, "date" | "companyId" | "companyName" | "employeeId" | "referrerName" | "customer" | "reference" | "amountCents" | "notes">;

/** Valida o corpo; erro = texto. Quem indicou: funcionário do RH (alcance de quem lança) ou texto livre. */
async function readFields(
  database: Database,
  scope: { allStores: boolean; companyId: string },
  body: JsonMap,
): Promise<{ fields: Fields; error: "" } | { fields: null; error: string }> {
  const fail = (error: string) => ({ fields: null, error });
  const date = safeText(body.date, 10);
  if (!DATE_PATTERN.test(date)) return fail("INFORME A DATA.");
  const companyId = safeText(body.companyId, 80);
  const companyNames = await loadCompanyNames(database);
  if (!companyNames.has(companyId) || (!scope.allStores && companyId !== scope.companyId)) return fail("ESCOLHA A LOJA.");
  const amountCents = nonNegativeInt(body.amountCents ?? 0);
  if (amountCents === null) return fail("O VALOR PRECISA SER POSITIVO (OU ZERO).");
  const employeeId = safeText(body.employeeId, 80);
  let referrerName = safeText(body.referrerName, 120).toLocaleUpperCase("pt-BR");
  if (employeeId) {
    const employee = await employeeInScope(database, scope, employeeId);
    if (!employee) return fail("FUNCIONÁRIO NÃO ENCONTRADO.");
    referrerName = employee.fullName.toLocaleUpperCase("pt-BR");
  }
  if (!referrerName) return fail("INFORME QUEM INDICOU.");
  const customer = safeText(body.customer, 160).toLocaleUpperCase("pt-BR");
  const reference = safeText(body.reference, 80).toLocaleUpperCase("pt-BR");
  if (!customer && !reference) return fail("INFORME O CLIENTE OU O ID DA VENDA / O.S.");
  return {
    fields: {
      date, companyId, companyName: companyNames.get(companyId) || "", employeeId, referrerName,
      customer, reference, amountCents, notes: safeText(body.notes, 500),
    },
    error: "",
  };
}

/** O que mudou numa edição, em texto para o histórico. */
function changes(before: Fields, after: Fields): string[] {
  const list: string[] = [];
  const add = (label: string, a: string, b: string) => { if (a !== b) list.push(`${label}: ${a || "—"} → ${b || "—"}`); };
  add("DATA", brDate(before.date), brDate(after.date));
  add("LOJA", before.companyName, after.companyName);
  add("QUEM INDICOU", before.referrerName, after.referrerName);
  add("CLIENTE", before.customer, after.customer);
  add("ID DA VENDA / O.S.", before.reference, after.reference);
  add("VALOR", brl(Number(before.amountCents) || 0), brl(after.amountCents));
  add("OBSERVAÇÃO", before.notes, after.notes);
  return list;
}

function entry(actor: Identity, action: HistoryEntry["action"], list: string[] = []): HistoryEntry {
  return { action, byName: actorName(actor), at: new Date().toISOString(), changes: list };
}

async function rowInScope(database: Database, scope: { allStores: boolean; companyId: string }, id: string) {
  if (!id) return null;
  const row = await database.prepare(`SELECT ${COLUMNS} FROM commercial_indications WHERE id=?1`).bind(id).first<Row>();
  if (!row || (!scope.allStores && row.companyId !== scope.companyId)) return null;
  return row;
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { scope } = checked;
  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);
  try {
    const database = await getD1();
    const [result, companyNames, employeesResult, byStore] = await Promise.all([
      database
        .prepare(`SELECT ${COLUMNS} FROM commercial_indications WHERE month=?1 ORDER BY date DESC, created_at DESC`)
        .bind(month)
        .all<Row>(),
      loadCompanyNames(database),
      database
        .prepare("SELECT id, full_name AS fullName, company_id AS companyId FROM hr_employees WHERE status='active' ORDER BY full_name ASC")
        .all<{ id: string; fullName: string; companyId: string }>(),
      indicationSummary(database, month, scope),
    ]);
    const items = (result.results ?? [])
      .filter((row) => scope.allStores || row.companyId === scope.companyId)
      .map(({ historyJson, ...row }) => ({
        ...row,
        companyName: companyNames.get(row.companyId) || row.companyName,
        amountCents: Number(row.amountCents) || 0,
        history: history({ historyJson }),
      }));
    // Por quem indicou: o funcionário (pelo id) ou o nome livre.
    const people = new Map<string, { name: string; companyName: string; count: number; totalCents: number }>();
    for (const item of items) {
      if (item.deletedAt) continue;
      const key = item.employeeId || `livre:${item.referrerName}`;
      const person = people.get(key) ?? { name: item.referrerName, companyName: item.companyName, count: 0, totalCents: 0 };
      person.count += 1;
      person.totalCents += item.amountCents;
      people.set(key, person);
    }
    return jsonResponse({
      month,
      items,
      byStore,
      byPerson: [...people.values()].sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name, "pt-BR")),
      stores: [...companyNames.entries()]
        .filter(([companyId]) => scope.allStores || companyId === scope.companyId)
        .map(([companyId, name]) => ({ companyId, name })),
      employees: (employeesResult.results ?? [])
        .filter((employee) => scope.allStores || employee.companyId === scope.companyId)
        .map((employee) => ({ id: employee.id, fullName: employee.fullName.toLocaleUpperCase("pt-BR"), companyId: employee.companyId })),
    });
  } catch (error) {
    console.error("Não foi possível carregar as indicações.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS INDICAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const { fields, error } = await readFields(database, scope, body);
    if (!fields) return jsonResponse({ error }, 400);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO commercial_indications
          (id, month, date, company_id, company_name, employee_id, referrer_name, customer, reference, amount_cents,
           notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, history_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        id, fields.date.slice(0, 7), fields.date, fields.companyId, fields.companyName, fields.employeeId,
        fields.referrerName, fields.customer, fields.reference, fields.amountCents, fields.notes,
        actor.id, actorName(actor), now, JSON.stringify([entry(actor, "CRIOU")]),
      )
      .run();
    return jsonResponse({ id }, 201);
  } catch (error) {
    console.error("Não foi possível lançar a indicação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LANÇAR A INDICAÇÃO." }, 500);
  }
}

export async function PUT(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const current = await rowInScope(database, scope, safeText(body.id, 80));
    if (!current || current.deletedAt) return jsonResponse({ error: "INDICAÇÃO NÃO ENCONTRADA." }, 404);
    const { fields, error } = await readFields(database, scope, body);
    if (!fields) return jsonResponse({ error }, 400);
    const list = changes(current, fields);
    if (!list.length) return jsonResponse({ id: current.id });
    await database
      .prepare(
        `UPDATE commercial_indications SET month=?1, date=?2, company_id=?3, company_name=?4, employee_id=?5,
           referrer_name=?6, customer=?7, reference=?8, amount_cents=?9, notes=?10, updated_by=?11,
           updated_by_name=?12, updated_at=?13, history_json=?14
         WHERE id=?15`,
      )
      .bind(
        fields.date.slice(0, 7), fields.date, fields.companyId, fields.companyName, fields.employeeId,
        fields.referrerName, fields.customer, fields.reference, fields.amountCents, fields.notes,
        actor.id, actorName(actor), new Date().toISOString(),
        JSON.stringify([...history(current), entry(actor, "EDITOU", list)]), current.id,
      )
      .run();
    return jsonResponse({ id: current.id });
  } catch (error) {
    console.error("Não foi possível editar a indicação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A INDICAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const database = await getD1();
    const current = await rowInScope(database, scope, safeText(new URL(request.url).searchParams.get("id"), 80));
    if (!current || current.deletedAt) return jsonResponse({ error: "INDICAÇÃO NÃO ENCONTRADA." }, 404);
    const now = new Date().toISOString();
    await database
      .prepare("UPDATE commercial_indications SET deleted_at=?1, deleted_by_name=?2, history_json=?3 WHERE id=?4")
      .bind(now, actorName(actor), JSON.stringify([...history(current), entry(actor, "EXCLUIU")]), current.id)
      .run();
    return jsonResponse({ id: current.id });
  } catch (error) {
    console.error("Não foi possível excluir a indicação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A INDICAÇÃO." }, 500);
  }
}
