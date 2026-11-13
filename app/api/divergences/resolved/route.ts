import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { isDateOnly, recifeDayStartIso, recifeNextDayStartIso } from "../../../lib/divergences";
import {
  allStoresForAny,
  canAny,
  identity,
  jsonResponse,
  READ_PERMISSIONS,
  safeText,
} from "../shared";

type Row = {
  itemId: string;
  companyId: string;
  companyName: string;
  productCode: string;
  productName: string;
  physicalQty: number | string;
  systemQty: number | string;
  status: string;
  stockResponse: string;
  storeReply: string;
  resolvedAt: string;
  resolvedByName: string;
  attachmentSide: string | null;
  attachmentName: string | null;
};

// Evento que RESOLVE o item: resposta do ADM que mudou o status para
// concluído/inventário. `alias` = apelido da tabela de eventos na consulta.
const resolvedEvent = (alias: string) =>
  `${alias}.kind='respond' AND ${alias}.to_status IN ('concluido','inventario') AND ${alias}.from_status<>${alias}.to_status`;

// PDF DE CONCLUÍDAS: itens RESOLVIDOS (concluído/inventário) no período,
// pela data da ÚLTIMA resolução — o último evento "respond" que mudou o
// status para concluído/inventário (INVENTARIADO, anexo e edição de
// observação gravam o mesmo status e não contam). Sem dados de abertura.
// Uma consulta só: anexos vêm no LEFT JOIN (uma linha por anexo).
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAny(actor, READ_PERMISSIONS)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VISUALIZAR AS DIVERGÊNCIAS." }, 403);
  }
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDateOnly(from) || !isDateOnly(to) || from > to) {
    return jsonResponse({ error: "INFORME A DATA INICIAL E A DATA FINAL." }, 400);
  }
  const allStores = allStoresForAny(actor, READ_PERMISSIONS);
  if (!allStores && !hasCompany(actor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }
  const requestedCompany = safeText(url.searchParams.get("companyId"), 80);
  const companyId = allStores ? (hasCompany(requestedCompany) ? requestedCompany : "") : actor.companyId;

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT i.id AS itemId, r.company_id AS companyId, r.company_name AS companyName,
                i.product_code AS productCode, i.product_name AS productName,
                i.physical_qty AS physicalQty, i.system_qty AS systemQty, i.status,
                i.stock_response AS stockResponse, i.store_reply AS storeReply,
                e.created_at AS resolvedAt, e.actor_name AS resolvedByName,
                a.side AS attachmentSide, a.file_name AS attachmentName
         FROM divergence_items i
         JOIN divergence_requests r ON r.id=i.request_id
         JOIN divergence_item_events e ON e.item_id=i.id AND ${resolvedEvent("e")}
           AND e.created_at=(SELECT MAX(e2.created_at) FROM divergence_item_events e2
             WHERE e2.item_id=i.id AND ${resolvedEvent("e2")})
         LEFT JOIN divergence_item_attachments a ON a.item_id=i.id
         WHERE i.status IN ('concluido','inventario') AND e.created_at>=?1 AND e.created_at<?2
           ${companyId ? "AND r.company_id=?3" : ""}
         ORDER BY r.company_name, e.created_at, i.id, a.created_at`,
      )
      .bind(recifeDayStartIso(from), recifeNextDayStartIso(to), ...(companyId ? [companyId] : []))
      .all<Row>();

    const items = new Map<string, Record<string, unknown> & { attachments: { side: string; fileName: string }[] }>();
    for (const row of result.results ?? []) {
      let item = items.get(row.itemId);
      if (!item) {
        item = {
          itemId: row.itemId, companyId: row.companyId, companyName: row.companyName,
          productCode: row.productCode, productName: row.productName,
          physicalQty: Number(row.physicalQty) || 0, systemQty: Number(row.systemQty) || 0,
          status: row.status, stockResponse: row.stockResponse, storeReply: row.storeReply,
          resolvedAt: row.resolvedAt, resolvedByName: row.resolvedByName, attachments: [],
        };
        items.set(row.itemId, item);
      }
      if (row.attachmentName) item.attachments.push({ side: row.attachmentSide || "", fileName: row.attachmentName });
    }
    return jsonResponse({ allStores, companyId, items: [...items.values()] });
  } catch (error) {
    console.error("Não foi possível carregar as divergências concluídas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS DIVERGÊNCIAS CONCLUÍDAS." }, 500);
  }
}
