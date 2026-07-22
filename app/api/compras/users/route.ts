import {
  apiErrorResponse,
  notionRequest,
  unauthorizedResponse,
} from "../../../lib/notion";

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
    const result = asRecord(await notionRequest("/users?page_size=100"));
    const users = Array.isArray(result.results)
      ? result.results
          .map((value) => {
            const user = asRecord(value);
            const person = asRecord(user.person);
            return {
              id: typeof user.id === "string" ? user.id : "",
              name: typeof user.name === "string" ? user.name : "",
              email: typeof person.email === "string" ? person.email : "",
            };
          })
          .filter((user) => user.id)
      : [];
    return Response.json({ users });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

