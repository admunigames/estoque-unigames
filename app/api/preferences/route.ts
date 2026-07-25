import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";

type JsonMap = Record<string, unknown>;

const DEFAULT_PREFERENCES = {
  theme: "dark",
  accentColor: "#4f86bd",
  logoDataUrl: "",
  compactMobile: false,
};
const encoder = new TextEncoder();

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function userId(request: Request) {
  return (request.headers.get("x-unigames-user-id") || "").trim();
}

function normalizePreferences(value: JsonMap) {
  const theme = value.theme === "light" ? "light" : "dark";
  const accentColor =
    typeof value.accentColor === "string" && /^#[0-9a-f]{6}$/i.test(value.accentColor)
      ? value.accentColor.toLowerCase()
      : DEFAULT_PREFERENCES.accentColor;
  const logoDataUrl =
    typeof value.logoDataUrl === "string" &&
    (!value.logoDataUrl ||
      (/^data:image\/(?:png|jpeg|webp);base64,/i.test(value.logoDataUrl) &&
        encoder.encode(value.logoDataUrl).byteLength <= 700_000))
      ? value.logoDataUrl
      : "";
  return {
    theme,
    accentColor,
    logoDataUrl,
    compactMobile: value.compactMobile === true,
  };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const id = userId(request);
  if (!id) return jsonResponse({ error: "USUÁRIO NÃO IDENTIFICADO." }, 401);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT theme, accent_color AS accentColor, logo_data_url AS logoDataUrl,
                compact_mobile AS compactMobile, updated_at AS updatedAt
         FROM user_preferences WHERE user_id = ?1 LIMIT 1`,
      )
      .bind(id)
      .first<Record<string, unknown>>();
    return jsonResponse({
      preferences: row
        ? { ...row, compactMobile: Number(row.compactMobile) === 1 }
        : DEFAULT_PREFERENCES,
    });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS PREFERÊNCIAS." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const id = userId(request);
  if (!id) return jsonResponse({ error: "USUÁRIO NÃO IDENTIFICADO." }, 401);

  try {
    const payload = (await request.json()) as JsonMap;
    const preferences = normalizePreferences(payload);
    const database = await getD1();
    await database
      .prepare(
        `INSERT INTO user_preferences
          (user_id, theme, accent_color, logo_data_url, compact_mobile, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           theme = excluded.theme,
           accent_color = excluded.accent_color,
           logo_data_url = excluded.logo_data_url,
           compact_mobile = excluded.compact_mobile,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        id,
        preferences.theme,
        preferences.accentColor,
        preferences.logoDataUrl,
        preferences.compactMobile ? 1 : 0,
      )
      .run();
    return jsonResponse({ preferences });
  } catch {
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR AS PREFERÊNCIAS." }, 500);
  }
}
