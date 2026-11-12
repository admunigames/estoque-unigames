import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageProductCatalog,
  identity,
  jsonResponse,
  sameOrigin,
  upsertProductCatalogEntries,
  type JsonMap,
  type ProductCatalogSource,
} from "../shared";

const MAX_ITEMS = 20000;

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageProductCatalog(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR PRODUTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const source: ProductCatalogSource = body.source === "pa" ? "pa" : "unigames";
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) {
      return jsonResponse({ error: "NENHUM PRODUTO ENCONTRADO NO ARQUIVO." }, 400);
    }
    const items = rawItems.slice(0, MAX_ITEMS).map((item) => {
      const record = item as JsonMap;
      return { code: String(record.code ?? ""), name: String(record.name ?? "") };
    });

    const cents = (value: unknown) => {
      const n = Number(value);
      return value !== null && value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 && n < 1e9 ? n : null;
    };
    const salePrices = new Map<string, { price: number | null; cost: number | null }>();
    if (source === "unigames") {
      for (const item of rawItems.slice(0, MAX_ITEMS)) {
        const record = item as JsonMap;
        const code = String(record.code ?? "").trim().slice(0, 80);
        if (code) salePrices.set(code, { price: cents(record.salePriceCents), cost: cents(record.costCents) });
      }
    }

    const database = await getD1();
    const result = await upsertProductCatalogEntries(database, source, items, actor, true, salePrices);
    return jsonResponse({ ...result });
  } catch (error) {
    console.error("Não foi possível processar o upload do catálogo de produtos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL PROCESSAR O ARQUIVO." }, 500);
  }
}
