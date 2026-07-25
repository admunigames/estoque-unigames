import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";

type JsonMap = Record<string, unknown>;

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function currentUserId(request: Request) {
  return cleanText(request.headers.get("x-unigames-user-id"), 80);
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  const ids = Array.from(
    new Set(
      new URL(request.url).searchParams
        .getAll("purchaseId")
        .map((value) => cleanText(value, 120))
        .filter(Boolean),
    ),
  ).slice(0, 50);
  if (!ids.length) return jsonResponse({ items: [] });

  try {
    const database = await getD1();
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
    const result = await database
      .prepare(
        `SELECT id, purchase_id AS purchaseId, delivered_at AS deliveredAt,
                percentage, quantity_note AS quantityNote, notes,
                created_by AS createdBy, created_at AS createdAt
         FROM purchase_delivery_records
         WHERE purchase_id IN (${placeholders})
         ORDER BY delivered_at DESC, created_at DESC`,
      )
      .bind(...ids)
      .all();
    return jsonResponse({ items: result.results ?? [] });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS ENTREGAS PARCIAIS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const payload = (await request.json()) as JsonMap;
    const purchaseId = cleanText(payload.purchaseId, 120);
    const deliveredAt = cleanText(payload.deliveredAt, 10);
    const quantityNote = cleanText(payload.quantityNote, 200);
    const notes = cleanText(payload.notes, 1000);
    const percentage = Math.max(1, Math.min(100, Math.round(Number(payload.percentage) || 0)));
    if (!purchaseId || !/^\d{4}-\d{2}-\d{2}$/.test(deliveredAt)) {
      return jsonResponse({ error: "INFORME O PEDIDO E A DATA DA ENTREGA." }, 400);
    }
    if (!quantityNote) {
      return jsonResponse({ error: "INFORME O QUE FOI RECEBIDO." }, 400);
    }
    const item = {
      id: crypto.randomUUID(),
      purchaseId,
      deliveredAt,
      percentage,
      quantityNote,
      notes,
      createdBy: currentUserId(request),
      createdAt: new Date().toISOString(),
    };
    const database = await getD1();
    await database
      .prepare(
        `INSERT INTO purchase_delivery_records
          (id, purchase_id, delivered_at, percentage, quantity_note, notes, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        item.id,
        item.purchaseId,
        item.deliveredAt,
        item.percentage,
        item.quantityNote,
        item.notes,
        item.createdBy,
        item.createdAt,
      )
      .run();
    return jsonResponse({ item }, 201);
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A ENTREGA PARCIAL." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const id = cleanText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "REGISTRO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM purchase_delivery_records WHERE id = ?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A ENTREGA PARCIAL." }, 500);
  }
}
