import {
  apiErrorResponse,
  buildPurchaseProperties,
  normalizePurchase,
  notionDataSourceId,
  notionRequest,
  parsePurchaseInput,
  unauthorizedResponse,
} from "../../lib/notion";

type JsonMap = Record<string, unknown>;

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : {};
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get("query") || "").trim().slice(0, 200);
    const status = (url.searchParams.get("status") || "").trim();
    const cursor = (url.searchParams.get("cursor") || "").trim();
    const filters: JsonMap[] = [];

    if (query) {
      filters.push({
        or: [
          { property: "FORNECEDOR", title: { contains: query } },
          { property: "LOJA", rich_text: { contains: query } },
          { property: "DIVISÃO", rich_text: { contains: query } },
        ],
      });
    }
    if (status) {
      filters.push({ property: "STATUS", status: { equals: status } });
    }

    const body: JsonMap = {
      page_size: 50,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    };
    if (cursor) body.start_cursor = cursor;
    if (filters.length === 1) body.filter = filters[0];
    if (filters.length > 1) body.filter = { and: filters };

    const result = asRecord(
      await notionRequest(`/data_sources/${notionDataSourceId()}/query`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const items = Array.isArray(result.results)
      ? result.results.map(normalizePurchase)
      : [];

    return Response.json({
      items,
      nextCursor:
        typeof result.next_cursor === "string" ? result.next_cursor : null,
      hasMore: result.has_more === true,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const input = parsePurchaseInput(await request.json());
    const result = await notionRequest("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: {
          type: "data_source_id",
          data_source_id: notionDataSourceId(),
        },
        properties: buildPurchaseProperties(input),
        template: { type: "default" },
      }),
    });
    return Response.json({ item: normalizePurchase(result) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
