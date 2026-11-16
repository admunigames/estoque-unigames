import { getD1 } from "../../../db";
import { recifeDate } from "../../lib/ordens-servico";
import { ACTIONS, actorName, can, guard, jsonResponse, safeText } from "./shared";

// Financeiro > Fornecedores a Pagar (permissões fornecedores_pagar:view/
// create/pay/delete). Cada lançamento é um PEDIDO: valor total numa moeda
// (BRL/USD, sem conversão), data do pedido (coluna planned_date), vários
// pagamentos até o total (ap_simple_payments) e anexos (./attachment).
// Vencimento = data do pedido + prazo do fornecedor (calculado na leitura;
// fornecedor sem prazo → sem vencimento). Programação (scheduled_date) é
// livre: qualquer data ou vazia. Interno: login com loja não vê nada.
//   GET                                                   → {suppliers, items, can}
//   POST  {kind:"fornecedor", name, paymentDays?}         (create) cadastro
//   POST  {supplierId, currency, amountCents, orderDate, notes} (create) pedido
//   PATCH {action:"supplier", optionId, paymentDays}      (create) prazo do fornecedor
//   PATCH {id, action:"edit", ...campos do POST}           (create)
//   PATCH {ids, action:"reschedule", scheduledDate}        (create) '' = sem data
//   PATCH {id, action:"payment", amountCents, paidDate, notes} (pay) um pagamento
//   PATCH {ids, action:"pay", paidDate?}                   (pay) quita o que falta; sem data = programada (vazia/futura → hoje)
//   PATCH {paymentId, action:"unpayment"}                  (pay) exclui um pagamento (guarda quem)
//   DELETE {ids}                                           (delete) pedidos
//   DELETE {optionId}                                      (create) cadastro

type Payload = Record<string, unknown>;
type Balance = { id: string; total: number; paid: number; scheduledDate: string };

const CURRENCIES = ["BRL", "USD"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IDS = 500;

const upper = (value: unknown, max: number) => safeText(value, max).toLocaleUpperCase("pt-BR");

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Prazo em dias (0–365) ou null = sem prazo; undefined = inválido. */
function paymentDays(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 && days <= 365 ? days : undefined;
}

async function body(request: Request): Promise<Payload> {
  const payload = await request.json().catch(() => null);
  return payload && typeof payload === "object" ? (payload as Payload) : {};
}

function idList(payload: Payload) {
  const raw = Array.isArray(payload.ids) ? payload.ids : payload.id ? [payload.id] : [];
  return [...new Set(raw.map((id) => safeText(id, 80)).filter(Boolean))].slice(0, MAX_IDS);
}

async function balances(database: D1Database, ids: string[]): Promise<Balance[]> {
  if (!ids.length) return [];
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const { results } = await database
    .prepare(`SELECT e.id, e.amount_cents AS total, e.scheduled_date AS scheduledDate,
      (SELECT COALESCE(SUM(p.amount_cents), 0) FROM ap_simple_payments p WHERE p.entry_id=e.id AND p.deleted=0) AS paid
      FROM ap_simple_entries e WHERE e.deleted=0 AND e.id IN (${placeholders})`)
    .bind(...ids)
    .all<Balance>();
  return results.map((row) => ({ ...row, total: Number(row.total), paid: Number(row.paid) }));
}

/** Recalcula status ('pago' = quitado) e paid_date (último pagamento) dos pedidos. */
async function sync(database: D1Database, ids: string[]) {
  const rows = await balances(database, ids);
  if (!rows.length) return;
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const { results: last } = await database
    .prepare(`SELECT entry_id AS entryId, MAX(paid_date) AS paidDate FROM ap_simple_payments
      WHERE deleted=0 AND entry_id IN (${placeholders}) GROUP BY entry_id`)
    .bind(...ids)
    .all<{ entryId: string; paidDate: string }>();
  const lastDate = new Map(last.map((row) => [row.entryId, row.paidDate]));
  const now = new Date().toISOString();
  await database.batch(rows.map((row) => {
    const paid = row.paid >= row.total;
    return database
      .prepare("UPDATE ap_simple_entries SET status=?2, paid_date=?3, updated_at=?4 WHERE id=?1")
      .bind(row.id, paid ? "pago" : "aberto", paid ? lastDate.get(row.id) || "" : "", now);
  }));
}

async function supplierExists(database: D1Database, id: string) {
  if (!id) return false;
  return Boolean(await database.prepare("SELECT id FROM ap_simple_options WHERE id=?1 AND kind='fornecedor' AND deleted=0").bind(id).first());
}

/** Campos do pedido validados (ou a mensagem de erro). */
async function entryFields(database: D1Database, payload: Payload) {
  const supplierId = safeText(payload.supplierId, 80);
  const currency = safeText(payload.currency, 3).toUpperCase() || "BRL";
  const amountCents = Number(payload.amountCents);
  const orderDate = safeText(payload.orderDate, 10);
  if (!(await supplierExists(database, supplierId))) return { error: "SELECIONE O FORNECEDOR." };
  if (!CURRENCIES.includes(currency)) return { error: "SELECIONE A MOEDA." };
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 1e11) return { error: "INFORME O VALOR TOTAL." };
  if (!DATE.test(orderDate)) return { error: "INFORME A DATA DO PEDIDO." };
  return { supplierId, currency, amountCents, orderDate, notes: upper(payload.notes, 500) };
}

export async function GET(request: Request) {
  const checked = guard(request, "view");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  // Cadastros 'tipo' (tipo de pagamento) ficam no banco, fora da tela.
  const { results: options } = await database
    .prepare("SELECT id, name, payment_days AS paymentDays, deleted FROM ap_simple_options WHERE kind='fornecedor' ORDER BY name")
    .all<{ id: string; name: string; paymentDays: number | null; deleted: number }>();
  const { results: items } = await database
    .prepare(`SELECT id, supplier_id AS supplierId, amount_cents AS amountCents, currency, planned_date AS orderDate,
      scheduled_date AS scheduledDate, notes, status, created_by_name AS createdByName, created_at AS createdAt
      FROM ap_simple_entries WHERE deleted=0 ORDER BY planned_date DESC, created_at DESC LIMIT 10000`)
    .all<{ id: string; supplierId: string; amountCents: number; orderDate: string }>();
  const { results: payments } = await database
    .prepare(`SELECT id, entry_id AS entryId, amount_cents AS amountCents, paid_date AS paidDate, notes, created_by_name AS createdByName
      FROM ap_simple_payments WHERE deleted=0 ORDER BY paid_date, created_at`)
    .all<{ entryId: string; amountCents: number }>();
  const { results: attachments } = await database
    .prepare(`SELECT id, entry_id AS entryId, file_name AS fileName, content_type AS contentType, size_bytes AS sizeBytes
      FROM ap_simple_attachments WHERE deleted=0 ORDER BY uploaded_at`)
    .all<{ entryId: string }>();
  const group = <T extends { entryId: string }>(list: T[]) => {
    const map = new Map<string, T[]>();
    list.forEach((row) => map.set(row.entryId, [...(map.get(row.entryId) || []), row]));
    return map;
  };
  const paymentsBy = group(payments.map((row) => ({ ...row, amountCents: Number(row.amountCents) })));
  const attachmentsBy = group(attachments);
  const days = new Map(options.map((row) => [row.id, row.paymentDays === null ? null : Number(row.paymentDays)]));
  return jsonResponse({
    // Cadastro excluído some das opções, mas o nome continua nos pedidos.
    suppliers: options.map(({ id, name, paymentDays: prazo, deleted }) => ({
      id, name, paymentDays: prazo === null ? null : Number(prazo), active: !Number(deleted),
    })),
    items: items.map((item) => {
      const list = paymentsBy.get(item.id) || [];
      const prazo = days.get(item.supplierId);
      return {
        ...item,
        amountCents: Number(item.amountCents),
        paidCents: list.reduce((sum, row) => sum + row.amountCents, 0),
        dueDate: prazo === null || prazo === undefined ? "" : addDays(item.orderDate, prazo),
        payments: list,
        attachments: attachmentsBy.get(item.id) || [],
      };
    }),
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
    const name = upper(payload.name, 120);
    const days = paymentDays(payload.paymentDays);
    if (payload.kind !== "fornecedor") return jsonResponse({ error: "CADASTRO INVÁLIDO." }, 400);
    if (!name) return jsonResponse({ error: "INFORME O NOME." }, 400);
    if (days === undefined) return jsonResponse({ error: "PRAZO INVÁLIDO (0 A 365 DIAS)." }, 400);
    const duplicate = await database
      .prepare("SELECT id FROM ap_simple_options WHERE kind='fornecedor' AND name=?1 AND deleted=0")
      .bind(name)
      .first();
    if (duplicate) return jsonResponse({ error: "JÁ EXISTE UM CADASTRO COM ESSE NOME." }, 409);
    const id = crypto.randomUUID();
    await database
      .prepare("INSERT INTO ap_simple_options (id, kind, name, payment_days, created_by_name, created_at) VALUES (?1, 'fornecedor', ?2, ?3, ?4, ?5)")
      .bind(id, name, days, actorName(actor), now)
      .run();
    return jsonResponse({ id }, 201);
  }

  const fields = await entryFields(database, payload);
  if ("error" in fields) return jsonResponse({ error: fields.error }, 400);
  const id = crypto.randomUUID();
  await database
    .prepare(`INSERT INTO ap_simple_entries (id, supplier_id, amount_cents, currency, planned_date, notes, status,
      created_by_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'aberto', ?7, ?8, ?8)`)
    .bind(id, fields.supplierId, fields.amountCents, fields.currency, fields.orderDate, fields.notes, actorName(actor), now)
    .run();
  return jsonResponse({ id }, 201);
}

export async function PATCH(request: Request) {
  const payload = await body(request);
  const action = safeText(payload.action, 20);
  const permission = ["pay", "payment", "unpayment"].includes(action) ? "pay" : "create";
  const checked = guard(request, permission);
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  const database = await getD1();
  const now = new Date().toISOString();
  const today = recifeDate();

  if (action === "supplier") {
    const optionId = safeText(payload.optionId, 80);
    const days = paymentDays(payload.paymentDays);
    if (days === undefined) return jsonResponse({ error: "PRAZO INVÁLIDO (0 A 365 DIAS)." }, 400);
    if (!(await supplierExists(database, optionId))) return jsonResponse({ error: "FORNECEDOR NÃO ENCONTRADO." }, 404);
    await database.prepare("UPDATE ap_simple_options SET payment_days=?2 WHERE id=?1").bind(optionId, days).run();
    return jsonResponse({ ok: true });
  }
  if (action === "unpayment") {
    const paymentId = safeText(payload.paymentId, 80);
    const row = await database
      .prepare("SELECT entry_id AS entryId FROM ap_simple_payments WHERE id=?1 AND deleted=0")
      .bind(paymentId)
      .first<{ entryId: string }>();
    if (!row) return jsonResponse({ error: "PAGAMENTO NÃO ENCONTRADO." }, 404);
    await database
      .prepare("UPDATE ap_simple_payments SET deleted=1, deleted_by_name=?2, deleted_at=?3 WHERE id=?1")
      .bind(paymentId, actorName(actor), now)
      .run();
    await sync(database, [row.entryId]);
    return jsonResponse({ ok: true });
  }

  const ids = idList(payload);
  if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM PEDIDO." }, 400);
  const rows = await balances(database, ids);
  if (!rows.length) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
  const open = rows.filter((row) => row.paid < row.total);

  if (action === "edit") {
    if (ids.length !== 1) return jsonResponse({ error: "EDITE UM PEDIDO POR VEZ." }, 400);
    const fields = await entryFields(database, payload);
    if ("error" in fields) return jsonResponse({ error: fields.error }, 400);
    if (fields.amountCents < rows[0].paid) return jsonResponse({ error: "O VALOR TOTAL NÃO PODE SER MENOR QUE O JÁ PAGO." }, 400);
    await database
      .prepare(`UPDATE ap_simple_entries SET supplier_id=?2, amount_cents=?3, currency=?4, planned_date=?5, notes=?6, updated_at=?7 WHERE id=?1`)
      .bind(rows[0].id, fields.supplierId, fields.amountCents, fields.currency, fields.orderDate, fields.notes, now)
      .run();
    await sync(database, [rows[0].id]);
    return jsonResponse({ ok: true });
  }
  if (action === "reschedule") {
    const scheduledDate = safeText(payload.scheduledDate, 10);
    if (scheduledDate && !DATE.test(scheduledDate)) return jsonResponse({ error: "DATA PROGRAMADA INVÁLIDA." }, 400);
    if (open.length) {
      await database.batch(open.map((row) => database
        .prepare("UPDATE ap_simple_entries SET scheduled_date=?2, updated_at=?3 WHERE id=?1")
        .bind(row.id, scheduledDate, now)));
    }
    return jsonResponse({ ok: true, changed: open.length, skipped: rows.length - open.length });
  }

  const paidDate = safeText(payload.paidDate, 10);
  if (paidDate && (!DATE.test(paidDate) || paidDate > today)) {
    return jsonResponse({ error: "INFORME A DATA DO PAGAMENTO (NÃO PODE SER FUTURA)." }, 400);
  }
  const insert = (entryId: string, amountCents: number, date: string, notes: string) => database
    .prepare(`INSERT INTO ap_simple_payments (id, entry_id, amount_cents, paid_date, notes, created_by_name, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(crypto.randomUUID(), entryId, amountCents, date, notes, actorName(actor), now);

  // ponytail: saldo conferido antes de gravar, sem trava; dois pagamentos
  // simultâneos no mesmo pedido podem passar do total (uso de 1–2 pessoas).
  if (action === "payment") {
    if (ids.length !== 1) return jsonResponse({ error: "UM PAGAMENTO POR VEZ." }, 400);
    const row = rows[0];
    const amountCents = Number(payload.amountCents);
    if (!paidDate) return jsonResponse({ error: "INFORME A DATA DO PAGAMENTO." }, 400);
    if (!Number.isInteger(amountCents) || amountCents <= 0) return jsonResponse({ error: "INFORME O VALOR PAGO." }, 400);
    if (amountCents > row.total - row.paid) return jsonResponse({ error: "O PAGAMENTO PASSA DO QUE FALTA PAGAR NESTE PEDIDO." }, 400);
    await insert(row.id, amountCents, paidDate, upper(payload.notes, 500)).run();
    await sync(database, [row.id]);
    return jsonResponse({ ok: true });
  }
  if (action === "pay") {
    // Quita o que falta. Sem data = na data programada (vazia ou futura → hoje).
    if (open.length) {
      await database.batch(open.map((row) => {
        const date = paidDate || (row.scheduledDate && row.scheduledDate <= today ? row.scheduledDate : today);
        return insert(row.id, row.total - row.paid, date, "");
      }));
      await sync(database, open.map((row) => row.id));
    }
    return jsonResponse({ ok: true, changed: open.length, skipped: rows.length - open.length });
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
  if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM PEDIDO." }, 400);
  await database.batch(ids.map((id) => database.prepare("UPDATE ap_simple_entries SET deleted=1 WHERE id=?1 AND deleted=0").bind(id)));
  return jsonResponse({ ok: true });
}
