import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { hasCompany } from "../../lib/access-scope";
import { recifeDate } from "../../lib/ordens-servico";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";

// Financeiro > Fornecedores a Pagar (permissões fornecedores_pagar:view/
// create/pay/delete). Só controle: cada lançamento tem UM pagamento (sem
// duplicatas/parcelas). Fornecedor e tipo de pagamento são cadastros SÓ deste
// módulo (ap_simple_options). Interno: login com loja vinculada não vê nada.
//   GET                                                        → {suppliers, types, items, can}
//   POST  {kind:"fornecedor"|"tipo", name}                     (create) cadastro
//   POST  {supplierId, paymentTypeId, amountCents, plannedDate, notes} (create)
//   PATCH {id, action:"edit", ...campos do POST}                (create)
//   PATCH {ids, action:"reschedule", plannedDate}               (create) só em aberto
//   PATCH {ids, action:"pay", paidDate?}                        (pay) sem data = na data programada (futura → hoje)
//   PATCH {ids, action:"unpay"}                                 (pay)
//   DELETE {ids}                                                (delete) lançamentos
//   DELETE {optionId}                                           (create) cadastro

type Actor = ReturnType<typeof identity>;
type Payload = Record<string, unknown>;

const ACTIONS = ["view", "create", "pay", "delete"];
const KINDS = ["fornecedor", "tipo"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IDS = 500;

const can = (actor: Actor, action: string) =>
  actor.role === "admin" || actor.permissions.includes(`fornecedores_pagar:${action}`);
const upper = (value: unknown, max: number) => safeText(value, max).toLocaleUpperCase("pt-BR");
const actorName = (actor: Actor) => actor.displayName || actor.id;

function guard(request: Request, action: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  const allowed = action === "view" ? ACTIONS.some((item) => can(actor, item)) : can(actor, action);
  if (!allowed || (actor.role !== "admin" && hasCompany(actor.companyId))) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA FORNECEDORES A PAGAR." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

async function body(request: Request): Promise<Payload> {
  const payload = await request.json().catch(() => null);
  return payload && typeof payload === "object" ? (payload as Payload) : {};
}

function idList(payload: Payload) {
  const raw = Array.isArray(payload.ids) ? payload.ids : payload.id ? [payload.id] : [];
  return [...new Set(raw.map((id) => safeText(id, 80)).filter(Boolean))].slice(0, MAX_IDS);
}

async function optionExists(database: D1Database, kind: string, id: string) {
  if (!id) return false;
  return Boolean(await database.prepare("SELECT id FROM ap_simple_options WHERE id=?1 AND kind=?2 AND deleted=0").bind(id, kind).first());
}

/** Campos do lançamento validados (ou a mensagem de erro). */
async function entryFields(database: D1Database, payload: Payload) {
  const supplierId = safeText(payload.supplierId, 80);
  const paymentTypeId = safeText(payload.paymentTypeId, 80);
  const amountCents = Number(payload.amountCents);
  const plannedDate = safeText(payload.plannedDate, 10);
  if (!(await optionExists(database, "fornecedor", supplierId))) return { error: "SELECIONE O FORNECEDOR." };
  if (!(await optionExists(database, "tipo", paymentTypeId))) return { error: "SELECIONE O TIPO DE PAGAMENTO." };
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 1e11) return { error: "INFORME O VALOR." };
  if (!DATE.test(plannedDate)) return { error: "INFORME A DATA PROGRAMADA DO PAGAMENTO." };
  return { supplierId, paymentTypeId, amountCents, plannedDate, notes: upper(payload.notes, 500) };
}

export async function GET(request: Request) {
  const checked = guard(request, "view");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  const { results: options } = await database
    .prepare("SELECT id, kind, name, deleted FROM ap_simple_options ORDER BY name")
    .all<{ id: string; kind: string; name: string; deleted: number }>();
  const { results: items } = await database
    .prepare(`SELECT id, supplier_id AS supplierId, payment_type_id AS paymentTypeId, amount_cents AS amountCents,
      planned_date AS plannedDate, notes, status, paid_date AS paidDate, paid_by_name AS paidByName, paid_at AS paidAt,
      created_by_name AS createdByName, created_at AS createdAt
      FROM ap_simple_entries WHERE deleted=0 ORDER BY planned_date DESC, created_at DESC LIMIT 10000`)
    .all();
  // Cadastro excluído some das opções, mas o nome continua nos lançamentos.
  const pick = (kind: string) => options.filter((item) => item.kind === kind).map(({ id, name, deleted }) => ({ id, name, active: !Number(deleted) }));
  return jsonResponse({
    suppliers: pick("fornecedor"),
    types: pick("tipo"),
    items,
    can: Object.fromEntries(ACTIONS.map((action) => [action, can(actor, action)])),
  });
}

export async function POST(request: Request) {
  const checked = guard(request, "create");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  const payload = await body(request);
  const now = new Date().toISOString();

  if (payload.kind !== undefined) {
    const kind = safeText(payload.kind, 20);
    const name = upper(payload.name, 120);
    if (!KINDS.includes(kind)) return jsonResponse({ error: "CADASTRO INVÁLIDO." }, 400);
    if (!name) return jsonResponse({ error: "INFORME O NOME." }, 400);
    const duplicate = await database
      .prepare("SELECT id FROM ap_simple_options WHERE kind=?1 AND name=?2 AND deleted=0")
      .bind(kind, name)
      .first();
    if (duplicate) return jsonResponse({ error: "JÁ EXISTE UM CADASTRO COM ESSE NOME." }, 409);
    const id = crypto.randomUUID();
    await database
      .prepare("INSERT INTO ap_simple_options (id, kind, name, created_by_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, kind, name, actorName(actor), now)
      .run();
    return jsonResponse({ id }, 201);
  }

  const fields = await entryFields(database, payload);
  if ("error" in fields) return jsonResponse({ error: fields.error }, 400);
  const id = crypto.randomUUID();
  await database
    .prepare(`INSERT INTO ap_simple_entries (id, supplier_id, payment_type_id, amount_cents, planned_date, notes, status,
      created_by_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'aberto', ?7, ?8, ?8)`)
    .bind(id, fields.supplierId, fields.paymentTypeId, fields.amountCents, fields.plannedDate, fields.notes, actorName(actor), now)
    .run();
  return jsonResponse({ id }, 201);
}

export async function PATCH(request: Request) {
  const payload = await body(request);
  const action = safeText(payload.action, 20);
  const permission = action === "pay" || action === "unpay" ? "pay" : "create";
  const checked = guard(request, permission);
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  const ids = idList(payload);
  if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM LANÇAMENTO." }, 400);
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const { results: rows } = await database
    .prepare(`SELECT id, status FROM ap_simple_entries WHERE deleted=0 AND id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; status: string }>();
  if (!rows.length) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
  const open = rows.filter((row) => row.status === "aberto").map((row) => row.id);
  const now = new Date().toISOString();
  const run = async (targets: string[], sql: string, ...values: unknown[]) => {
    if (!targets.length) return;
    await database.batch(targets.map((id) => database.prepare(sql).bind(id, ...values)));
  };

  if (action === "edit") {
    if (ids.length !== 1) return jsonResponse({ error: "EDITE UM LANÇAMENTO POR VEZ." }, 400);
    const fields = await entryFields(database, payload);
    if ("error" in fields) return jsonResponse({ error: fields.error }, 400);
    await run([rows[0].id], `UPDATE ap_simple_entries SET supplier_id=?2, payment_type_id=?3, amount_cents=?4, planned_date=?5,
      notes=?6, updated_at=?7 WHERE id=?1`, fields.supplierId, fields.paymentTypeId, fields.amountCents, fields.plannedDate, fields.notes, now);
    return jsonResponse({ ok: true });
  }
  if (action === "reschedule") {
    const plannedDate = safeText(payload.plannedDate, 10);
    if (!DATE.test(plannedDate)) return jsonResponse({ error: "INFORME A NOVA DATA PROGRAMADA." }, 400);
    await run(open, "UPDATE ap_simple_entries SET planned_date=?2, updated_at=?3 WHERE id=?1", plannedDate, now);
    return jsonResponse({ ok: true, changed: open.length, skipped: rows.length - open.length });
  }
  if (action === "pay") {
    // Sem data = pago NA data programada de cada lançamento.
    const paidDate = safeText(payload.paidDate, 10);
    if (paidDate && (!DATE.test(paidDate) || paidDate > recifeDate())) {
      return jsonResponse({ error: "INFORME A DATA DO PAGAMENTO (NÃO PODE SER FUTURA)." }, 400);
    }
    if (paidDate) {
      await run(open, `UPDATE ap_simple_entries SET status='pago', paid_date=?2, paid_by_name=?3, paid_at=?4, updated_at=?4
        WHERE id=?1`, paidDate, actorName(actor), now);
    } else {
      // Programado para o futuro e já pago → hoje (data de pagamento nunca futura).
      await run(open, `UPDATE ap_simple_entries SET status='pago',
        paid_date=CASE WHEN planned_date > ?4 THEN ?4 ELSE planned_date END, paid_by_name=?2, paid_at=?3, updated_at=?3
        WHERE id=?1`, actorName(actor), now, recifeDate());
    }
    return jsonResponse({ ok: true, changed: open.length, skipped: rows.length - open.length });
  }
  if (action === "unpay") {
    const paid = rows.filter((row) => row.status === "pago").map((row) => row.id);
    await run(paid, "UPDATE ap_simple_entries SET status='aberto', paid_date='', paid_by_name='', paid_at='', updated_at=?2 WHERE id=?1", now);
    return jsonResponse({ ok: true, changed: paid.length });
  }
  return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
}

export async function DELETE(request: Request) {
  const payload = await body(request);
  const optionId = safeText(payload.optionId, 80);
  const checked = guard(request, optionId ? "create" : "delete");
  if ("error" in checked) return checked.error;
  const database = await getD1();
  if (optionId) {
    const found = await database.prepare("SELECT id FROM ap_simple_options WHERE id=?1 AND deleted=0").bind(optionId).first();
    if (!found) return jsonResponse({ error: "CADASTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("UPDATE ap_simple_options SET deleted=1 WHERE id=?1").bind(optionId).run();
    return jsonResponse({ ok: true });
  }
  const ids = idList(payload);
  if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM LANÇAMENTO." }, 400);
  await database.batch(ids.map((id) => database.prepare("UPDATE ap_simple_entries SET deleted=1 WHERE id=?1 AND deleted=0").bind(id)));
  return jsonResponse({ ok: true });
}
