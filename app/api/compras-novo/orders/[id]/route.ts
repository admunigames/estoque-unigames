import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";

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
  wonAt: string;
  wonBy: string;
  wonByName: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

type OrderItemRow = {
  id: string;
  orderId: string;
  draftItemId: string;
  productCode: string;
  productName: string;
  quantity: number;
  receivedQuantity: number;
  unitPriceCents: number;
  targetStores: string;
  candidateSupplierIds: string;
  notes: string;
};

type SupplierRow = { id: string; name: string };

type QuoteRow = { itemId: string; supplierId: string; unitPriceCents: number; notes: string };

type LinkedInvoiceRow = {
  id: string;
  invoiceNumber: string;
  series: string;
  totalAmountCents: number;
  financialStatus: string;
};

// Fase F: 'aberto' e 'aguardando_chegada' são os valores do pipeline novo
// (só pedidos nativos) — 'pendente'/'em_andamento' continuam válidos porque
// pedidos importados do Notion (origin='notion_import') seguem usando eles.
const VALID_STATUSES = new Set(["aberto", "aguardando_chegada", "pendente", "em_andamento", "concluido"]);

// Fase D, item 1: as 5 opções de STATUS DA DIVISÃO que o Notion já usa
// (ver db/scripts/import-notion-purchases.mjs) — "" (não definido) também é
// aceito, pra permitir limpar o campo.
const VALID_DIVISION_STATUSES = new Set([
  "",
  "FALTA DIVISÃO",
  "AGUARDANDO APROVAÇÃO",
  "ENVIAR DIVISÃO A LOJA",
  "FALTANDO ENVIO COMPLETO DA DIVISÃO",
  "CONCLUÍDO",
]);

async function loadOrder(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT id, origin, notion_purchase_id AS notionPurchaseId, notion_purchase_url AS notionPurchaseUrl,
              supplier_id AS supplierId, supplier_name_raw AS supplierNameRaw,
              company_id AS companyId, company_name AS companyName,
              order_date AS orderDate, expected_date AS expectedDate, received_date AS receivedDate,
              division, division_status AS divisionStatus, status, no_items_detailed AS noItemsDetailed, notes,
              canceled, won_at AS wonAt, won_by AS wonBy, won_by_name AS wonByName,
              created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
              updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
       FROM purchase_orders WHERE id=?1`,
    )
    .bind(id)
    .first<OrderRow>();
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const order = await loadOrder(database, id);
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);

    let supplierName = order.supplierNameRaw;
    if (order.origin === "native" && order.supplierId) {
      const supplier = await database
        .prepare("SELECT id, name FROM finance_suppliers WHERE id=?1")
        .bind(order.supplierId)
        .first<SupplierRow>();
      supplierName = supplier?.name || "";
    }

    let items: (OrderItemRow & { candidateSupplierIdsList: string[]; quotes: { supplierId: string; supplierName: string; unitPriceCents: number; notes: string }[] })[] = [];
    if (!order.noItemsDetailed) {
      const itemsResult = await database
        .prepare(
          `SELECT id, order_id AS orderId, draft_item_id AS draftItemId, product_code AS productCode,
                  product_name AS productName, quantity, received_quantity AS receivedQuantity,
                  unit_price_cents AS unitPriceCents, target_stores AS targetStores,
                  candidate_supplier_ids AS candidateSupplierIds, notes
           FROM purchase_order_items WHERE order_id=?1 ORDER BY created_at ASC`,
        )
        .bind(id)
        .all<OrderItemRow>();
      const rawItems = itemsResult.results ?? [];

      // Fase F: cotações por item (purchase_order_item_quotes), com nome do
      // fornecedor resolvido via finance_suppliers — junta tudo aqui pra UI
      // não precisar de N requisições extras pra montar a seção de cotação.
      const itemIds = rawItems.map((item) => item.id);
      const quotesByItemId = new Map<string, QuoteRow[]>();
      const supplierNameById = new Map<string, string>();
      if (itemIds.length) {
        const placeholders = itemIds.map((_, index) => `?${index + 1}`).join(",");
        const quotesResult = await database
          .prepare(
            `SELECT item_id AS itemId, supplier_id AS supplierId, unit_price_cents AS unitPriceCents, notes
             FROM purchase_order_item_quotes WHERE item_id IN (${placeholders})`,
          )
          .bind(...itemIds)
          .all<QuoteRow>();
        for (const row of quotesResult.results ?? []) {
          const list = quotesByItemId.get(row.itemId) ?? [];
          list.push(row);
          quotesByItemId.set(row.itemId, list);
        }
        const supplierIds = Array.from(new Set((quotesResult.results ?? []).map((row) => row.supplierId)));
        if (supplierIds.length) {
          const supplierPlaceholders = supplierIds.map((_, index) => `?${index + 1}`).join(",");
          const suppliersResult = await database
            .prepare(`SELECT id, name FROM finance_suppliers WHERE id IN (${supplierPlaceholders})`)
            .bind(...supplierIds)
            .all<SupplierRow>();
          for (const row of suppliersResult.results ?? []) supplierNameById.set(row.id, row.name);
        }
      }

      items = rawItems.map((item) => ({
        ...item,
        candidateSupplierIdsList: (() => {
          try {
            const parsed = JSON.parse(item.candidateSupplierIds || "[]");
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })(),
        quotes: (quotesByItemId.get(item.id) ?? []).map((quote) => ({
          supplierId: quote.supplierId,
          supplierName: supplierNameById.get(quote.supplierId) || "",
          unitPriceCents: quote.unitPriceCents,
          notes: quote.notes,
        })),
      }));
    }

    // NF já vinculada a este pedido nativo (Fase C, item 2) — usada pela UI
    // pra decidir entre mostrar o resumo da NF ou os botões de criar/vincular.
    const linkedInvoice = await database
      .prepare(
        `SELECT id, invoice_number AS invoiceNumber, series, total_amount_cents AS totalAmountCents,
                financial_status AS financialStatus
         FROM supplier_invoices WHERE purchase_order_id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<LinkedInvoiceRow>();

    return jsonResponse({ order: { ...order, supplierName }, items, linkedInvoice: linkedInvoice || null });
  } catch (error) {
    console.error("Não foi possível carregar o pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O PEDIDO." }, 500);
  }
}

// PATCH: notes, status (manual — útil pra pedidos importados do Notion,
// que não têm itens pra calcular status automaticamente), expectedDate,
// receivedDate, canceled e, desde a Fase D, division/divisionStatus (aba
// "Divisão", mesma UI pra pedidos nativos e importados do Notion).
// origin/notionPurchaseId/supplierId não são editáveis nesta fase.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const order = await loadOrder(database, id);
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);

    const body = (await request.json()) as JsonMap;
    const notes = body.notes === undefined ? order.notes : safeText(body.notes, 2000);
    const expectedDate = body.expectedDate === undefined ? order.expectedDate : safeText(body.expectedDate, 20);
    const receivedDate = body.receivedDate === undefined ? order.receivedDate : safeText(body.receivedDate, 20);
    const status = body.status === undefined ? order.status : safeText(body.status, 20);
    if (!VALID_STATUSES.has(status)) {
      return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);
    }
    // Fase F: Divisão só pode ser preenchida a partir de 'aguardando_chegada'
    // (depois que o vencedor foi definido) — antes disso a seção fica oculta
    // na UI, e o servidor bloqueia mesmo que a requisição venha direto.
    // Pedidos importados do Notion (status pendente/em_andamento/concluido)
    // sempre puderam editar Divisão, então só bloqueia quando o pedido está
    // no status inicial do pipeline novo ('aberto').
    if ((body.division !== undefined || body.divisionStatus !== undefined) && order.status === "aberto") {
      return jsonResponse({ error: "DIVISÃO SÓ PODE SER PREENCHIDA A PARTIR DE 'AGUARDANDO CHEGADA'." }, 400);
    }
    const division = body.division === undefined ? order.division : safeText(body.division, 20000);
    const divisionStatus = body.divisionStatus === undefined ? order.divisionStatus : safeText(body.divisionStatus, 60);
    if (!VALID_DIVISION_STATUSES.has(divisionStatus)) {
      return jsonResponse({ error: "STATUS DA DIVISÃO INVÁLIDO." }, 400);
    }
    // Cancelar/reabrir (Fase C, item 4) — ação explícita, independente do
    // status operacional. A confirmação extra pra cancelar um pedido já
    // 'concluido' é feita no client (confirm()); aqui só gravamos o que
    // veio no corpo.
    const canceled = body.canceled === undefined ? Boolean(order.canceled) : Boolean(body.canceled);

    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `UPDATE purchase_orders
         SET notes=?1, expected_date=?2, received_date=?3, status=?4, canceled=?5, division=?6, division_status=?7,
             updated_by=?8, updated_by_name=?9, updated_at=CURRENT_TIMESTAMP
         WHERE id=?10`,
      )
      .bind(notes, expectedDate, receivedDate, status, canceled ? 1 : 0, division, divisionStatus, actor.id, actorName, id)
      .run();

    return jsonResponse({ updated: true, id, canceled });
  } catch (error) {
    console.error("Não foi possível editar o pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O PEDIDO." }, 500);
  }
}
