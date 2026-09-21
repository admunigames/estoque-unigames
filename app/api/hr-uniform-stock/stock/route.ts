import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  PIECE_TYPES,
  SIZES,
  canViewUniformStock,
  identity,
  jsonResponse,
} from "../shared";

// Saldo atual por combinação tipo+tamanho. As 36 linhas já existem desde a
// migration (pré-semeadas com stock_qty=0) — este GET nunca precisa criar
// linha, só ler o que já está lá.

type StockRow = { pieceType: string; size: string; stockQty: number };

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewUniformStock(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FARDAMENTO." }, 403);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare("SELECT piece_type AS pieceType, size, stock_qty AS stockQty FROM uniform_stock_items")
      .all<StockRow>();
    const rows = result.results ?? [];
    const byKey = new Map(rows.map((row) => [`${row.pieceType}:${row.size}`, row.stockQty]));
    // Garante as 36 combinações na resposta mesmo se alguma linha faltar.
    const items = PIECE_TYPES.flatMap((pieceType) =>
      SIZES.map((size) => ({
        pieceType,
        size,
        stockQty: byKey.get(`${pieceType}:${size}`) ?? 0,
      })),
    );
    return jsonResponse({ items });
  } catch (error) {
    console.error("Não foi possível carregar o estoque de fardamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O ESTOQUE." }, 500);
  }
}
