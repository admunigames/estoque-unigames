import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  CAPTURE_SELECT,
  canAccessCaptures,
  canSeePhoto,
  identity,
  safeText,
  uploadsBucket,
  type CaptureRow,
} from "../shared";

function textResponse(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return textResponse("VOCÊ NÃO TEM ACESSO À CAPTAÇÃO.", 403);
  }

  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return textResponse("PRODUTO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(`${CAPTURE_SELECT} WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<CaptureRow>();
    if (!row) return textResponse("PRODUTO NÃO ENCONTRADO.", 404);
    if (!canSeePhoto(actor, row)) {
      return textResponse("VOCÊ NÃO TEM ACESSO A ESTA FOTO.", 403);
    }
    if (!row.photoKey) return textResponse("ESTE PRODUTO NÃO TEM FOTO.", 404);

    const bucket = await uploadsBucket();
    const object = await bucket.get(row.photoKey);
    if (!object) return textResponse("FOTO NÃO ENCONTRADA.", 404);

    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Não foi possível carregar a foto da captação.", error);
    return textResponse("NÃO FOI POSSÍVEL CARREGAR A FOTO.", 500);
  }
}
