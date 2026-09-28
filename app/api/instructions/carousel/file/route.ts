import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { contentDisposition, documentsBucket } from "../../../documents/shared";

type FileRow = {
  fileName: string;
  r2Key: string;
  contentType: string;
};

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function carouselFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return fileError("IMAGEM INVÁLIDA.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT file_name AS fileName, r2_key AS r2Key, content_type AS contentType
         FROM instruction_carousel_images WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("IMAGEM NÃO ENCONTRADA.", 404);

    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": row.contentType || "image/jpeg",
      "content-disposition": contentDisposition(row.fileName, false),
      "content-length": String(object.size),
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag: object.httpEtag,
    });
    const body = head ? null : (object as R2ObjectBody).body;
    return new Response(body, { headers });
  } catch (error) {
    console.error("Não foi possível abrir a imagem do carrossel.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR A IMAGEM.", 500);
  }
}

export async function GET(request: Request) {
  return carouselFile(request);
}

export async function HEAD(request: Request) {
  return carouselFile(request, true);
}
