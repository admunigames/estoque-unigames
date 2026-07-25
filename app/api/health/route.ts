import { getD1 } from "../../../db";
import { notionRequest, unauthorizedResponse } from "../../lib/notion";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  let database = false;
  let notion = false;
  let notionMessage = "";
  try {
    const d1 = await getD1();
    await d1.prepare("SELECT 1 AS ok").first();
    database = true;
  } catch {
    database = false;
  }
  try {
    await notionRequest("/users/me");
    notion = true;
  } catch (error) {
    notionMessage = error instanceof Error ? error.message : "INTEGRAÇÃO INDISPONÍVEL.";
  }

  return Response.json(
    {
      database,
      notion,
      notionMessage,
      checkedAt: new Date().toISOString(),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
