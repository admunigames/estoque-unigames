import { canActOnStore, canSeeAllStores, NO_COMPANY_ERROR, resolveStoreScope } from "../../lib/access-scope";
import { unauthorizedResponse } from "../../lib/notion";
import { notifyUsers, usersWithPermission, vapidFromEnv } from "../../lib/hr-notify";
import { recifeDate } from "../../lib/ordens-servico";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";
import { semNfKey } from "../compras-novo/shared";

// Estoque > Recebimento (migration 0147). Página NOVA sobre os pedidos do
// Compras, sem alterar o módulo: só LÊ purchase_orders/items e GRAVA nos
// mesmos campos que o Compras usa (received_quantity — a quantidade real,
// pode passar do pedido desde 25/11/2026 —, received_date e os anexos
// 'nota_fiscal', uma ou mais NFs por compra). Nunca muda o status do pedido:
// quem conclui é sempre o Compras (decisão de 25/11/2026).
//
// NENHUM VALOR sai daqui, para ninguém: as consultas nem selecionam preço,
// custo, total, NF do financeiro ou texto da divisão. O PDF da nota só abre
// para quem acompanha todas as lojas (recebimento:acompanhar sem loja).
//
// Permissões: recebimento:loja (enviar nota/conferir/corrigir na própria
// loja) e recebimento:acompanhar (ver todas as lojas, PDF, e-mails, trocar a
// loja de chegada e receber os avisos). Login com loja só vê a própria loja
// de chegada (access-scope.ts), e só pedidos aguardando_chegada/concluido.

export type Actor = ReturnType<typeof identity>;
type Db = D1Database;

export const ALL_STORES_PERMISSION = "recebimento:acompanhar";
export const DIVERGENCES = ["faltou", "veio_a_mais", "cor_diferente", "modelo_diferente", "avariado", "outro"] as const;
// Marcadas pela loja (exigem observação); faltou/veio_a_mais saem da contagem.
const MANUAL_DIVERGENCES = new Set(["cor_diferente", "modelo_diferente", "avariado", "outro"]);
export const EMAILS_KEY = "recebimento_emails";
export const DEFAULT_EMAILS = ["financeiro@unigameslojas.com", "douglas@unigameslojas.com", "renatofreire.unigames@gmail.com"];
// ponytail: concluídos só dos últimos 60 dias na lista; paginar se a loja pedir histórico antigo.
const DONE_DAYS = 60;

export const canRegister = (actor: Actor) => actor.role === "admin" || actor.permissions.includes("recebimento:loja");
export const canFollow = (actor: Actor) => canSeeAllStores(actor, ALL_STORES_PERMISSION);
export { jsonResponse, safeText };

export function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canRegister(actor) && !actor.permissions.includes(ALL_STORES_PERMISSION)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA O RECEBIMENTO." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  const scope = resolveStoreScope(actor, ALL_STORES_PERMISSION);
  if (scope.blocked) return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  return { actor, allStores: scope.allStores };
}

export const NOT_FOUND = "COMPRA NÃO ENCONTRADA.";
export const actorName = (actor: Actor) => (actor.displayName || actor.id).toLocaleUpperCase("pt-BR");

type ReceiptItem = { itemId: string; counted: number; divergence: string; note: string };
type Extra = { productName: string; quantity: number; note: string };
export type HistoryEntry = { at: string; type: string; byName: string } & Record<string, unknown>;

type OrderRow = {
  id: string; supplierId: string; supplierNameRaw: string; companyId: string; companyName: string;
  orderDate: string; expectedDate: string; receivedDate: string; status: string; divisionStatus: string;
  noItemsDetailed: number; notes: string;
  deliveryCompanyId: string | null; deliveryCompanyName: string | null; nfNumber: string | null;
  nfAttachmentId: string | null; nfSentByName: string | null; nfSentAt: string | null;
  checkedByName: string | null; checkedAt: string | null;
  itemsJson: string | null; extrasJson: string | null; historyJson: string | null; version: number | null;
};

const ORDER_SELECT = `SELECT po.id, po.supplier_id AS supplierId, po.supplier_name_raw AS supplierNameRaw,
    po.company_id AS companyId, po.company_name AS companyName, po.order_date AS orderDate,
    po.expected_date AS expectedDate, po.received_date AS receivedDate, po.status,
    po.division_status AS divisionStatus, po.no_items_detailed AS noItemsDetailed, po.notes,
    r.delivery_company_id AS deliveryCompanyId, r.delivery_company_name AS deliveryCompanyName,
    r.nf_number AS nfNumber, r.nf_attachment_id AS nfAttachmentId, r.nf_sent_by_name AS nfSentByName,
    r.nf_sent_at AS nfSentAt, r.checked_by_name AS checkedByName, r.checked_at AS checkedAt,
    r.items_json AS itemsJson, r.extras_json AS extrasJson, r.history_json AS historyJson, r.version
  FROM purchase_orders po LEFT JOIN purchase_receipts r ON r.order_id = po.id`;
// Loja de chegada: a da tabela nova; vazia = LOJA QUE FATURA do pedido.
const DELIVERY = "COALESCE(NULLIF(r.delivery_company_id, ''), po.company_id)";
const VISIBLE = "po.origin = 'native' AND po.canceled = 0";

function parse<T>(text: string | null | undefined): T[] {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function daysAgo(days: number) {
  return recifeDate(new Date(Date.now() - days * 864e5));
}

export async function loadOrderRows(db: Db, actor: Actor, allStores: boolean, orderId = "") {
  const where = [VISIBLE];
  const values: unknown[] = [];
  if (orderId) {
    values.push(orderId);
    where.push(`po.id = ?${values.length}`);
    where.push("po.status IN ('aguardando_chegada', 'concluido')");
  } else {
    values.push(daysAgo(DONE_DAYS));
    where.push(`(po.status = 'aguardando_chegada' OR (po.status = 'concluido' AND po.updated_at >= ?${values.length}))`);
  }
  if (!allStores) {
    values.push(actor.companyId);
    where.push(`${DELIVERY} = ?${values.length}`);
  }
  const { results } = await db
    .prepare(`${ORDER_SELECT} WHERE ${where.join(" AND ")} ORDER BY po.expected_date, po.created_at DESC`)
    .bind(...values)
    .all<OrderRow>();
  return results ?? [];
}

/** Pedido único dentro do escopo do login, ou null (mesmo 404 para "de outra loja"). */
export async function loadOrder(db: Db, actor: Actor, orderId: string) {
  const [row] = await loadOrderRows(db, actor, true, orderId);
  if (!row) return null;
  const delivery = row.deliveryCompanyId || row.companyId;
  return canActOnStore(actor, ALL_STORES_PERMISSION, delivery) ? row : null;
}

type ItemRow = { id: string; orderId: string; productCode: string; productName: string; quantity: number; receivedQuantity: number };

export async function loadItems(db: Db, orderIds: string[]) {
  if (!orderIds.length) return [];
  const marks = orderIds.map((_, index) => `?${index + 1}`).join(",");
  const { results } = await db
    .prepare(
      `SELECT id, order_id AS orderId, product_code AS productCode, product_name AS productName,
              quantity, received_quantity AS receivedQuantity
       FROM purchase_order_items WHERE order_id IN (${marks}) ORDER BY created_at, id`,
    )
    .bind(...orderIds)
    .all<ItemRow>();
  return results ?? [];
}

const divergenceFor = (counted: number, quantity: number) => (counted < quantity ? "faltou" : counted > quantity ? "veio_a_mais" : "");

/** Divergência final de um item: a marcada pela loja (com observação) ou a da contagem. */
export function resolveDivergence(counted: number, quantity: number, chosen: unknown, note: string): { divergence: string; error?: string } {
  const picked = typeof chosen === "string" ? chosen : "";
  if (picked && !(DIVERGENCES as readonly string[]).includes(picked)) return { divergence: "", error: "DIVERGÊNCIA INVÁLIDA." };
  if (MANUAL_DIVERGENCES.has(picked)) {
    if (!note) return { divergence: picked, error: "DESCREVA A DIVERGÊNCIA NA OBSERVAÇÃO." };
    return { divergence: picked };
  }
  return { divergence: divergenceFor(counted, quantity) };
}

/** O que a página mostra. Sem nenhum valor (preço/custo/total/NF/divisão). */
export async function buildView(db: Db, rows: OrderRow[], follow: boolean) {
  const ids = rows.map((row) => row.id);
  const items = await loadItems(db, ids);
  const supplierIds = [...new Set(rows.map((row) => row.supplierId).filter(Boolean))];
  const supplierNames = new Map<string, string>();
  if (supplierIds.length) {
    const { results } = await db
      .prepare(`SELECT id, name FROM finance_suppliers WHERE id IN (${supplierIds.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...supplierIds)
      .all<{ id: string; name: string }>();
    for (const row of results ?? []) supplierNames.set(row.id, row.name);
  }
  const nfOk = new Set<string>();
  if (ids.length) {
    const marks = ids.map((_, i) => `?${i + 1}`).join(",");
    const linked = await db
      .prepare(`SELECT DISTINCT purchase_order_id AS orderId FROM supplier_invoices WHERE purchase_order_id IN (${marks})`)
      .bind(...ids)
      .all<{ orderId: string }>();
    for (const row of linked.results ?? []) nfOk.add(row.orderId);
    const semNf = await db
      .prepare(`SELECT state_key AS stateKey FROM shared_state WHERE state_key IN (${marks})`)
      .bind(...ids.map(semNfKey))
      .all<{ stateKey: string }>();
    for (const row of semNf.results ?? []) nfOk.add(row.stateKey.slice(semNfKey("").length));
  }
  const today = recifeDate();
  return rows.map((row) => {
    const counts = new Map(parse<ReceiptItem>(row.itemsJson).map((entry) => [entry.itemId, entry]));
    const history = parse<HistoryEntry>(row.historyJson);
    const nfSent = Boolean(row.nfSentAt);
    const checked = Boolean(row.checkedAt);
    return {
      id: row.id,
      supplierName: supplierNames.get(row.supplierId) || row.supplierNameRaw || String(row.notes || "").split("\n")[0] || "PEDIDO SEM NOME",
      billingCompanyId: row.companyId,
      billingCompanyName: row.companyName,
      deliveryCompanyId: row.deliveryCompanyId || row.companyId,
      deliveryCompanyName: row.deliveryCompanyName || row.companyName,
      deliveryChanged: Boolean(row.deliveryCompanyId),
      orderDate: row.orderDate,
      expectedDate: row.expectedDate,
      receivedDate: row.receivedDate,
      status: row.status,
      late: row.status === "aguardando_chegada" && !checked && Boolean(row.expectedDate) && row.expectedDate < today,
      noItems: Boolean(row.noItemsDetailed),
      nfNumber: row.nfNumber || "",
      nfSentByName: row.nfSentByName || "",
      nfSentAt: row.nfSentAt || "",
      checkedByName: row.checkedByName || "",
      checkedAt: row.checkedAt || "",
      steps: { nota: nfSent, conferida: checked, nf: nfOk.has(row.id), divisao: row.divisionStatus === "CONCLUÍDO", concluido: row.status === "concluido" },
      items: items
        .filter((item) => item.orderId === row.id)
        .map((item) => {
          const count = counts.get(item.id);
          const counted = count ? Number(count.counted) : null;
          return {
            id: item.id,
            productCode: item.productCode,
            productName: item.productName,
            quantity: Number(item.quantity),
            receivedQuantity: Number(item.receivedQuantity),
            counted,
            excess: counted === null ? 0 : Math.max(counted - Number(item.quantity), 0),
            divergence: count?.divergence || "",
            note: count?.note || "",
            // O Compras mexeu direto na QTD RECEBIDA depois da loja.
            changedByCompras: counted !== null && Number(item.receivedQuantity) !== counted,
          };
        }),
      notas: history
        .filter((entry) => entry.type === "nota")
        .map((entry) => ({
          nfNumber: String(entry.nfNumber || ""), byName: entry.byName, at: entry.at,
          ...(follow ? { attachmentId: String(entry.attachmentId || "") } : {}),
        })),
      extras: parse<Extra>(row.extrasJson),
      history: follow ? history : history.filter((entry) => entry.type !== "email"),
    };
  });
}

export async function loadEmails(db: Db): Promise<string[]> {
  const row = await db.prepare("SELECT value_json AS value FROM shared_state WHERE state_key=?1").bind(EMAILS_KEY).first<{ value: string }>();
  const list = parse<string>(row?.value).filter((email) => typeof email === "string" && email);
  return list.length === 3 ? list : DEFAULT_EMAILS;
}

/** Push para quem acompanha (recebimento:acompanhar). Falha de push não derruba a ação. */
export async function notifyFollowers(db: Db, orderId: string, title: string, body: string) {
  try {
    const recipients = await usersWithPermission(db, [ALL_STORES_PERMISSION]);
    await notifyUsers(db, vapidFromEnv(process.env), recipients, {
      push: { title, body, url: `/recebimento?pedido=${encodeURIComponent(orderId)}`, tag: `recebimento-${orderId}` },
    });
  } catch (error) {
    console.error("Falha ao avisar o Compras do recebimento.", error);
  }
}

export function upperNote(value: unknown, max = 500) {
  return safeText(value, max).toLocaleUpperCase("pt-BR");
}

export function parseJson<T>(text: string | null | undefined): T[] {
  return parse<T>(text);
}
