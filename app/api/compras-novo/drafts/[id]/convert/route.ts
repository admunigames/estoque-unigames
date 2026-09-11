import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, newId, safeText, sameOrigin, type JsonMap } from "../../../shared";

type DraftRow = { id: string; name: string; status: string };

type DraftItemRow = {
  id: string;
  productCode: string;
  productName: string;
  quantity: number;
  targetStores: string;
};

type SupplierRow = { id: string; name: string };

// Fase B: "Transformar rascunho em pedido" — 1 purchase_orders por
// fornecedor escolhido (agrupando os itens do rascunho pelo supplierId
// que o usuário selecionou para cada um, não pelos candidateSupplierIds
// em si — o cliente é obrigado a mandar exatamente um fornecedor por
// item, escolhido dentre os candidatos ou não).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONVERTER RASCUNHOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: draftId } = await context.params;

  try {
    const database = await getD1();
    const draft = await database
      .prepare("SELECT id, name, status FROM purchase_drafts WHERE id=?1")
      .bind(draftId)
      .first<DraftRow>();
    if (!draft) return jsonResponse({ error: "RASCUNHO NÃO ENCONTRADO." }, 404);
    if (draft.status !== "aberto") {
      return jsonResponse({ error: "SÓ É POSSÍVEL CONVERTER UM RASCUNHO ABERTO." }, 409);
    }

    const itemsResult = await database
      .prepare(
        `SELECT id, product_code AS productCode, product_name AS productName, quantity, target_stores AS targetStores
         FROM purchase_draft_items WHERE draft_id=?1 ORDER BY created_at ASC`,
      )
      .bind(draftId)
      .all<DraftItemRow>();
    const items = itemsResult.results ?? [];
    if (!items.length) {
      return jsonResponse({ error: "ESTE RASCUNHO NÃO TEM ITENS PARA CONVERTER." }, 400);
    }

    const body = (await request.json()) as JsonMap;
    const choicesRaw = Array.isArray(body.itemSupplierChoices) ? body.itemSupplierChoices : [];
    const supplierIdByItemId = new Map<string, string>();
    for (const entry of choicesRaw) {
      const record = entry && typeof entry === "object" ? (entry as JsonMap) : {};
      const itemId = safeText(record.itemId, 80);
      const supplierId = safeText(record.supplierId, 80);
      if (itemId && supplierId) supplierIdByItemId.set(itemId, supplierId);
    }

    const missingItem = items.find((item) => !supplierIdByItemId.get(item.id));
    if (missingItem) {
      return jsonResponse(
        { error: `ESCOLHA UM FORNECEDOR PARA TODOS OS ITENS ANTES DE CONVERTER (FALTA: ${missingItem.productCode}).` },
        400,
      );
    }

    const supplierIds = Array.from(new Set(Array.from(supplierIdByItemId.values())));
    const placeholders = supplierIds.map((_, index) => `?${index + 1}`).join(",");
    const suppliersResult = await database
      .prepare(`SELECT id, name FROM finance_suppliers WHERE id IN (${placeholders})`)
      .bind(...supplierIds)
      .all<SupplierRow>();
    const supplierById = new Map((suppliersResult.results ?? []).map((row) => [row.id, row.name]));
    const invalidSupplierId = supplierIds.find((id) => !supplierById.has(id));
    if (invalidSupplierId) {
      return jsonResponse({ error: "UM DOS FORNECEDORES ESCOLHIDOS NÃO FOI ENCONTRADO." }, 400);
    }

    // Agrupa os itens do rascunho pelo fornecedor escolhido — 1 grupo = 1
    // purchase_orders novo.
    const itemsBySupplier = new Map<string, DraftItemRow[]>();
    for (const item of items) {
      const supplierId = supplierIdByItemId.get(item.id) as string;
      const group = itemsBySupplier.get(supplierId) ?? [];
      group.push(item);
      itemsBySupplier.set(supplierId, group);
    }

    const actorName = actor.displayName || "Administrador";
    const statements: { sql: string; values: unknown[] }[] = [];
    const orderIds: string[] = [];

    for (const [supplierId, groupItems] of itemsBySupplier) {
      const orderId = newId();
      orderIds.push(orderId);
      const supplierName = supplierById.get(supplierId) || "";
      const notes = `Convertido do rascunho: ${draft.name} (${draft.id})`;
      statements.push({
        sql: `INSERT INTO purchase_orders
                (id, origin, notion_purchase_id, notion_purchase_url, supplier_id, supplier_name_raw,
                 company_id, company_name, order_date, expected_date, received_date, division, division_status,
                 status, no_items_detailed, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
              VALUES
                (?1, 'native', '', '', ?2, ?3, '', '', '', '', '', '', '', 'em_andamento', 0, ?4, ?5, ?6, CURRENT_TIMESTAMP, ?5, ?6, CURRENT_TIMESTAMP)`,
        values: [orderId, supplierId, supplierName, notes, actor.id, actorName],
      });

      for (const item of groupItems) {
        statements.push({
          sql: `INSERT INTO purchase_order_items
                  (id, order_id, draft_item_id, product_code, product_name, quantity, received_quantity, target_stores,
                   notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
                VALUES
                  (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, '', ?8, ?9, CURRENT_TIMESTAMP, ?8, ?9, CURRENT_TIMESTAMP)`,
          values: [newId(), orderId, item.id, item.productCode, item.productName, item.quantity, item.targetStores, actor.id, actorName],
        });
      }
    }

    statements.push({
      sql: `UPDATE purchase_drafts SET status='convertido', updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3`,
      values: [actor.id, actorName, draftId],
    });

    const prepared = statements.map((statement) => database.prepare(statement.sql).bind(...statement.values));
    await database.batch(prepared);

    return jsonResponse({ converted: true, orderIds });
  } catch (error) {
    console.error("Não foi possível converter o rascunho de compra em pedidos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONVERTER O RASCUNHO EM PEDIDOS." }, 500);
  }
}
