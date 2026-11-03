import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { hasCompany } from "../../lib/access-scope";
import { recifeDate } from "../../lib/ordens-servico";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";
import { loadStores } from "../inventario/shared";

// Estoque > Reintegração Fiscal (permissões reintegracao_fiscal:view/create/
// emit/delete). Durante a semana o colaborador anota cada cancelamento (ID da
// venda e/ou nº da nota, loja, data e quem solicitou); no dia da emissão fecha
// um a um com a data e o nº da nota de reintegração. Informação INTERNA:
// login com loja vinculada não vê nada (nem com a permissão).
//   GET                                   → {stores, items, can}
//   POST  {companyId, saleId, invoiceNumber, requestedDate, requestedBy}  (create)
//   PATCH {id, action:"emit", reintegrationDate, reintegrationNumber}     (emit)
//   PATCH {id, action:"reopen"}                                           (emit)
//   DELETE {id}                                                           (delete)

type Actor = ReturnType<typeof identity>;
type Row = { id: string; status: string; requestedDate: string };

const ACTIONS = ["view", "create", "emit", "delete"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOT_FOUND = "LANÇAMENTO NÃO ENCONTRADO.";

const can = (actor: Actor, action: string) =>
  actor.role === "admin" || actor.permissions.includes(`reintegracao_fiscal:${action}`);
const upper = (value: unknown, max: number) => safeText(value, max).toLocaleUpperCase("pt-BR");

function guard(request: Request, action: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  const allowed = action === "view" ? ACTIONS.some((item) => can(actor, item)) : can(actor, action);
  if (!allowed || (actor.role !== "admin" && hasCompany(actor.companyId))) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA A REINTEGRAÇÃO FISCAL." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const payload = await request.json().catch(() => null);
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/** Campos do lançamento validados (ou a mensagem de erro). */
async function entryFields(database: D1Database, payload: Record<string, unknown>) {
  const store = (await loadStores(database)).find((item) => item.id === safeText(payload.companyId, 80));
  const saleId = upper(payload.saleId, 60);
  const invoiceNumber = upper(payload.invoiceNumber, 60);
  const requestedDate = safeText(payload.requestedDate, 10);
  if (!store) return { error: "SELECIONE A LOJA." };
  if (!saleId && !invoiceNumber) return { error: "INFORME O ID DA VENDA OU O Nº DA NOTA." };
  if (!DATE.test(requestedDate) || requestedDate > recifeDate()) return { error: "INFORME A DATA DA SOLICITAÇÃO (NÃO PODE SER FUTURA)." };
  return {
    companyId: store.id, companyName: String(store.name).toLocaleUpperCase("pt-BR"), saleId, invoiceNumber, requestedDate,
    requestedBy: upper(payload.requestedBy, 120),
  };
}

async function findRow(database: D1Database, id: string) {
  return id
    ? database.prepare("SELECT id, status, requested_date AS requestedDate FROM fiscal_reintegrations WHERE id=?1 AND deleted=0").bind(id).first<Row>()
    : null;
}

export async function GET(request: Request) {
  const checked = guard(request, "view");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  const { results } = await database
    .prepare(`SELECT id, company_id AS companyId, company_name AS companyName, sale_id AS saleId, invoice_number AS invoiceNumber,
      requested_date AS requestedDate, requested_by AS requestedBy, status, reintegration_date AS reintegrationDate,
      reintegration_number AS reintegrationNumber, created_by_name AS createdByName, created_at AS createdAt,
      closed_by_name AS closedByName, closed_at AS closedAt
      FROM fiscal_reintegrations WHERE deleted=0 ORDER BY requested_date DESC, created_at DESC LIMIT 5000`)
    .all();
  return jsonResponse({
    stores: await loadStores(database),
    items: results,
    can: Object.fromEntries(ACTIONS.map((action) => [action, can(actor, action)])),
  });
}

export async function POST(request: Request) {
  const checked = guard(request, "create");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  const fields = await entryFields(database, await body(request));
  if ("error" in fields) return jsonResponse({ error: fields.error }, 400);
  const id = crypto.randomUUID();
  await database
    .prepare(`INSERT INTO fiscal_reintegrations (id, company_id, company_name, sale_id, invoice_number, requested_date, requested_by,
      status, created_by, created_by_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'aberto', ?8, ?9, ?10)`)
    .bind(id, fields.companyId, fields.companyName, fields.saleId, fields.invoiceNumber, fields.requestedDate, fields.requestedBy,
      actor.id, actor.displayName || actor.id, new Date().toISOString())
    .run();
  return jsonResponse({ id }, 201);
}

export async function PATCH(request: Request) {
  const payload = await body(request);
  const action = safeText(payload.action, 20);
  const checked = guard(request, "emit");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  const row = await findRow(database, safeText(payload.id, 80));
  if (!row) return jsonResponse({ error: NOT_FOUND }, 404);

  if (action === "emit") {
    if (row.status !== "aberto") return jsonResponse({ error: "ESTE LANÇAMENTO JÁ FOI EMITIDO." }, 409);
    const date = safeText(payload.reintegrationDate, 10);
    const number = upper(payload.reintegrationNumber, 60);
    if (!DATE.test(date) || date > recifeDate() || date < row.requestedDate) {
      return jsonResponse({ error: "INFORME A DATA DA EMISSÃO (ENTRE A SOLICITAÇÃO E HOJE)." }, 400);
    }
    if (!number) return jsonResponse({ error: "INFORME O Nº DA NOTA DE REINTEGRAÇÃO." }, 400);
    await database
      .prepare(`UPDATE fiscal_reintegrations SET status='emitido', reintegration_date=?2, reintegration_number=?3,
        closed_by=?4, closed_by_name=?5, closed_at=?6 WHERE id=?1`)
      .bind(row.id, date, number, actor.id, actor.displayName || actor.id, new Date().toISOString())
      .run();
    return jsonResponse({ ok: true });
  }
  if (action === "reopen") {
    await database
      .prepare(`UPDATE fiscal_reintegrations SET status='aberto', reintegration_date='', reintegration_number='',
        closed_by='', closed_by_name='', closed_at='' WHERE id=?1`)
      .bind(row.id)
      .run();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
}

export async function DELETE(request: Request) {
  const checked = guard(request, "delete");
  if ("error" in checked) return checked.error;
  const database = await getD1();
  const row = await findRow(database, safeText((await body(request)).id, 80));
  if (!row) return jsonResponse({ error: NOT_FOUND }, 404);
  await database.prepare("UPDATE fiscal_reintegrations SET deleted=1 WHERE id=?1").bind(row.id).run();
  return jsonResponse({ ok: true });
}
