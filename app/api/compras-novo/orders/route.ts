import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, newId, safeText, sameOrigin, type JsonMap } from "../shared";

type OrderRow = {
  id: string;
  origin: string;
  notionPurchaseId: string;
  notionPurchaseUrl: string;
  supplierId: string;
  supplierNameRaw: string;
  companyId: string;
  companyName: string;
  orderDate: string;
  expectedDate: string;
  receivedDate: string;
  division: string;
  divisionStatus: string;
  status: string;
  noItemsDetailed: number;
  notes: string;
  canceled: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

type SupplierRow = { id: string; name: string };
type ItemCountRow = { orderId: string; itemCount: number };

// Fase B: lista pedidos nativos (origin='native') e importados do Notion
// (origin='notion_import') JUNTOS — a importação do Notion existe
// justamente para virar histórico consultável/editável dentro do mesmo
// módulo, ver decisão confirmada no escopo da Fase B.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  const url = new URL(request.url);
  const status = safeText(url.searchParams.get("status"), 20);
  const origin = safeText(url.searchParams.get("origin"), 20);
  // Cancelado some da visão padrão (mesmo padrão do checkbox "mostrar
  // arquivados/convertidos" da aba Rascunhos) — só reaparece com
  // includeCanceled=1.
  const includeCanceled = url.searchParams.get("includeCanceled") === "1";

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (status) {
      values.push(status);
      conditions.push(`status=?${values.length}`);
    }
    if (origin) {
      values.push(origin);
      conditions.push(`origin=?${values.length}`);
    }
    if (!includeCanceled) {
      conditions.push(`canceled=0`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const ordersResult = await database
      .prepare(
        `SELECT id, origin, notion_purchase_id AS notionPurchaseId, notion_purchase_url AS notionPurchaseUrl,
                supplier_id AS supplierId, supplier_name_raw AS supplierNameRaw,
                company_id AS companyId, company_name AS companyName,
                order_date AS orderDate, expected_date AS expectedDate, received_date AS receivedDate,
                division, division_status AS divisionStatus, status, no_items_detailed AS noItemsDetailed, notes,
                canceled,
                created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
                updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM purchase_orders
         ${where}
         ORDER BY created_at DESC`,
      )
      .bind(...values)
      .all<OrderRow>();
    const orders = ordersResult.results ?? [];

    // Nomes de fornecedor pra pedidos nativos (supplierNameRaw só é
    // preenchido nos importados do Notion) — 2 queries simples em vez de
    // um join pesado, como pedido no escopo.
    const nativeSupplierIds = Array.from(
      new Set(orders.filter((order) => order.origin === "native" && order.supplierId).map((order) => order.supplierId)),
    );
    const supplierNameById = new Map<string, string>();
    if (nativeSupplierIds.length) {
      const placeholders = nativeSupplierIds.map((_, index) => `?${index + 1}`).join(",");
      const suppliersResult = await database
        .prepare(`SELECT id, name FROM finance_suppliers WHERE id IN (${placeholders})`)
        .bind(...nativeSupplierIds)
        .all<SupplierRow>();
      for (const row of suppliersResult.results ?? []) supplierNameById.set(row.id, row.name);
    }

    const orderIds = orders.map((order) => order.id);
    const itemCountByOrderId = new Map<string, number>();
    if (orderIds.length) {
      const placeholders = orderIds.map((_, index) => `?${index + 1}`).join(",");
      const countsResult = await database
        .prepare(
          `SELECT order_id AS orderId, COUNT(*) AS itemCount
           FROM purchase_order_items WHERE order_id IN (${placeholders}) GROUP BY order_id`,
        )
        .bind(...orderIds)
        .all<ItemCountRow>();
      for (const row of countsResult.results ?? []) itemCountByOrderId.set(row.orderId, Number(row.itemCount));
    }

    const enriched = orders.map((order) => ({
      ...order,
      supplierName: order.origin === "native" ? supplierNameById.get(order.supplierId) || "" : order.supplierNameRaw,
      itemCount: itemCountByOrderId.get(order.id) || 0,
    }));

    return jsonResponse({ orders: enriched });
  } catch (error) {
    console.error("Não foi possível carregar os pedidos de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PEDIDOS." }, 500);
  }
}

// Fase F: cria um pedido de compra nativo já como purchase_orders — não
// existe mais a etapa de "rascunho" separada (fundida nesta fase). Nasce
// em status='aberto', sem fornecedor definido (supplierId/supplierNameRaw
// vazios até a definição do vencedor, ver POST /orders/:id/winner).
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CRIAR PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    // Nome é opcional (diferente do antigo rascunho, que exigia nome) — não
    // existe coluna própria pra isso em purchase_orders (o "nome" de um
    // pedido importado do Notion sempre foi o fornecedor), então guardamos
    // como a primeira linha de notes, mesmo padrão já usado pra anotar a
    // origem de conversão nas fases anteriores. A UI mostra o fornecedor
    // como título assim que o vencedor é definido; até lá, mostra este nome
    // (ou "PEDIDO SEM NOME").
    const name = safeText(body.name, 160);
    const extraNotes = safeText(body.notes, 2000);
    const notes = name ? (extraNotes ? `${name}\n${extraNotes}` : name) : extraNotes;

    const database = await getD1();
    const id = newId();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO purchase_orders
          (id, origin, notion_purchase_id, notion_purchase_url, supplier_id, supplier_name_raw,
           company_id, company_name, order_date, expected_date, received_date, division, division_status,
           status, no_items_detailed, notes, canceled, won_at, won_by, won_by_name,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES
          (?1, 'native', '', '', '', '', '', '', '', '', '', '', '', 'aberto', 0, ?2, 0, '', '', '',
           ?3, ?4, CURRENT_TIMESTAMP, ?3, ?4, CURRENT_TIMESTAMP)`,
      )
      .bind(id, notes, actor.id, actorName)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar o pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CRIAR O PEDIDO." }, 500);
  }
}
