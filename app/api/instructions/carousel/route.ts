import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { documentsBucket, safeR2FileName } from "../../documents/shared";

// Carrossel de imagens no topo da página de Instruções (até MAX_IMAGES),
// mesmo fluxo em partes (create/chunk/complete/cancel) das rotas de anexo
// já existentes no projeto (ex. app/api/documents/route.ts), só que restrito
// a imagens pequenas e com um limite de linhas na tabela em vez de 1 anexo
// por registro.

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};
type CarouselRow = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  position: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

const MAX_IMAGES = 4;
const IMAGE_CHUNK_SIZE = 512 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

type StagedImage = {
  fileName: string;
  contentType: string;
  fileSize: number;
  numberOfParts: number;
};

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canManageInstructions(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("instructions:manage");
}

function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

function validFileName(fileName: string) {
  return (
    fileName.length > 0 &&
    fileName.length <= 180 &&
    !fileName.includes("/") &&
    !fileName.includes("\\")
  );
}

function stagingPrefix(sessionId: string) {
  return `instructions/carousel/_pending/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${stagingPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

function sessionIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function imageMetadataError(metadata: StagedImage) {
  if (!validFileName(metadata.fileName)) return "SELECIONE UMA IMAGEM VÁLIDA.";
  if (!ACCEPTED_CONTENT_TYPES.has(metadata.contentType)) {
    return "ENVIE UMA IMAGEM EM PNG, JPG OU WEBP.";
  }
  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize <= 0) {
    return "A IMAGEM ESTÁ VAZIA OU É INVÁLIDA.";
  }
  if (metadata.fileSize > MAX_IMAGE_SIZE) {
    return "A IMAGEM DEVE TER NO MÁXIMO 10 MB.";
  }
  return "";
}

async function readMetadata(bucket: R2Bucket, sessionId: string) {
  const object = await bucket.get(metadataKey(sessionId));
  if (!object) return null;
  return JSON.parse(await object.text()) as StagedImage;
}

async function removeStaged(bucket: R2Bucket, sessionId: string) {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix: `${stagingPrefix(sessionId)}/`,
      limit: 1000,
      cursor,
    });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function createSession(payload: JsonMap) {
  const database = await getD1();
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM instruction_carousel_images")
    .first<{ total: number }>();
  if (Number(count?.total ?? 0) >= MAX_IMAGES) {
    return jsonResponse({ error: "O CARROSSEL JÁ TEM O MÁXIMO DE " + MAX_IMAGES + " IMAGENS." }, 400);
  }

  const metadata: StagedImage = {
    fileName: safeText(payload.fileName, 180),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: typeof payload.fileSize === "number" ? payload.fileSize : Number(payload.fileSize),
    numberOfParts: typeof payload.numberOfParts === "number" ? payload.numberOfParts : Number(payload.numberOfParts),
  };
  const error = imageMetadataError(metadata);
  if (error) return jsonResponse({ error }, 400);

  const expectedParts = Math.ceil(metadata.fileSize / IMAGE_CHUNK_SIZE);
  if (!Number.isInteger(metadata.numberOfParts) || metadata.numberOfParts !== expectedParts) {
    return jsonResponse({ error: "A DIVISÃO DO ARQUIVO É INVÁLIDA. SELECIONE-O NOVAMENTE." }, 400);
  }

  const sessionId = crypto.randomUUID();
  const bucket = await documentsBucket();
  await bucket.put(metadataKey(sessionId), JSON.stringify(metadata), {
    httpMetadata: { contentType: "application/json" },
  });
  return jsonResponse({ session: { id: sessionId, numberOfParts: expectedParts } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = safeText(request.headers.get("x-instruction-carousel-upload-id"), 80);
  const partNumber = Number(request.headers.get("x-instruction-carousel-part-number"));
  if (!sessionIdIsValid(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
    return jsonResponse({ error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  const metadata = await readMetadata(bucket, sessionId);
  if (!metadata) {
    return jsonResponse({ error: "O ENVIO DA IMAGEM EXPIROU. SELECIONE-A NOVAMENTE." }, 410);
  }
  if (partNumber > metadata.numberOfParts) {
    return jsonResponse({ error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bytes = await request.arrayBuffer();
  const expectedSize =
    partNumber === metadata.numberOfParts
      ? metadata.fileSize - (metadata.numberOfParts - 1) * IMAGE_CHUNK_SIZE
      : IMAGE_CHUNK_SIZE;
  if (bytes.byteLength !== expectedSize || bytes.byteLength > IMAGE_CHUNK_SIZE) {
    return jsonResponse({ error: "UMA PARTE DO ARQUIVO CHEGOU INCOMPLETA. TENTE NOVAMENTE." }, 400);
  }

  await bucket.put(partKey(sessionId, partNumber), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return jsonResponse({ partNumber });
}

async function completeSession(payload: JsonMap, actor: Identity) {
  const sessionId = safeText(payload.sessionId, 80);
  if (!sessionIdIsValid(sessionId)) {
    return jsonResponse({ error: "O ENVIO DA IMAGEM EXPIROU. SELECIONE-A NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    if (!metadata) {
      return jsonResponse({ error: "O ENVIO DA IMAGEM EXPIROU. SELECIONE-A NOVAMENTE." }, 410);
    }
    const metadataError = imageMetadataError(metadata);
    if (metadataError) return jsonResponse({ error: metadataError }, 400);

    const database = await getD1();
    const count = await database
      .prepare("SELECT COUNT(*) AS total FROM instruction_carousel_images")
      .first<{ total: number }>();
    if (Number(count?.total ?? 0) >= MAX_IMAGES) {
      return jsonResponse({ error: "O CARROSSEL JÁ TEM O MÁXIMO DE " + MAX_IMAGES + " IMAGENS." }, 400);
    }

    const parts: ArrayBuffer[] = [];
    let receivedSize = 0;
    for (let partNumber = 1; partNumber <= metadata.numberOfParts; partNumber += 1) {
      const object = await bucket.get(partKey(sessionId, partNumber));
      if (!object) {
        return jsonResponse({ error: "O ENVIO DA IMAGEM FICOU INCOMPLETO. TENTE NOVAMENTE." }, 400);
      }
      const part = await object.arrayBuffer();
      receivedSize += part.byteLength;
      parts.push(part);
    }
    if (receivedSize !== metadata.fileSize) {
      return jsonResponse({ error: "O TAMANHO FINAL DA IMAGEM NÃO CONFERE. TENTE NOVAMENTE." }, 400);
    }

    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    const id = crypto.randomUUID();
    const r2Key = `instructions/carousel/${id}/${safeR2FileName(metadata.fileName)}`;
    const createdAt = new Date().toISOString();

    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: metadata.contentType },
      customMetadata: { uploadedBy: actor.id, uploadedAt: createdAt },
    });

    try {
      const nextPosition = await database
        .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM instruction_carousel_images")
        .first<{ nextPosition: number }>();
      await database
        .prepare(
          `INSERT INTO instruction_carousel_images
            (id, r2_key, file_name, content_type, size_bytes, position,
             created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          id,
          r2Key,
          metadata.fileName,
          metadata.contentType,
          metadata.fileSize,
          Number(nextPosition?.nextPosition ?? 0),
          actor.id,
          actor.displayName || "Administrador",
          createdAt,
        )
        .run();
    } catch (error) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw error;
    }

    return jsonResponse({ image: { id, fileName: metadata.fileName } }, 201);
  } finally {
    await removeStaged(bucket, sessionId).catch(() => undefined);
  }
}

async function cancelSession(payload: JsonMap) {
  const sessionId = safeText(payload.sessionId, 80);
  if (sessionIdIsValid(sessionId)) {
    const bucket = await documentsBucket();
    await removeStaged(bucket, sessionId);
  }
  return new Response(null, { status: 204 });
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, file_name AS fileName, content_type AS contentType,
                size_bytes AS sizeBytes, position,
                created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
         FROM instruction_carousel_images
         ORDER BY position ASC, created_at ASC`,
      )
      .all<CarouselRow>();
    const images = (result.results ?? []).map((row) => ({
      ...row,
      viewUrl: `/api/instructions/carousel/file?id=${encodeURIComponent(row.id)}`,
    }));
    return jsonResponse({ images, maxImages: MAX_IMAGES });
  } catch (error) {
    console.error("Não foi possível listar as imagens do carrossel.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CARROSSEL." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageInstructions(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR O CARROSSEL." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await request.json()) as JsonMap;
      const action = safeText(payload.action, 20);
      if (action === "create") return await createSession(payload);
      if (action === "complete") return await completeSession(payload, actor);
      if (action === "cancel") return await cancelSession(payload);
      return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
    }
    if (contentType.includes("application/octet-stream")) {
      return await storeChunk(request);
    }
    return jsonResponse({ error: "TIPO DE REQUISIÇÃO INVÁLIDO." }, 400);
  } catch (error) {
    console.error("Não foi possível processar a imagem do carrossel.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENVIAR A IMAGEM." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageInstructions(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REORDENAR O CARROSSEL." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const order = Array.isArray(body.order)
      ? body.order.filter((value): value is string => typeof value === "string")
      : [];
    if (!order.length) return jsonResponse({ error: "ORDEM INVÁLIDA." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM instruction_carousel_images")
      .all<{ id: string }>();
    const existingIds = new Set((existing.results ?? []).map((row) => row.id));
    const orderedIds = new Set(order);
    if (order.length !== existingIds.size || existingIds.size !== orderedIds.size) {
      return jsonResponse({ error: "A ORDEM ENVIADA NÃO CORRESPONDE ÀS IMAGENS ATUAIS." }, 400);
    }
    for (const id of order) {
      if (!existingIds.has(id)) return jsonResponse({ error: "A ORDEM ENVIADA NÃO CORRESPONDE ÀS IMAGENS ATUAIS." }, 400);
    }

    for (let index = 0; index < order.length; index += 1) {
      await database
        .prepare("UPDATE instruction_carousel_images SET position=?1 WHERE id=?2")
        .bind(index, order[index])
        .run();
    }
    return jsonResponse({ reordered: true });
  } catch (error) {
    console.error("Não foi possível reordenar o carrossel.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REORDENAR O CARROSSEL." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageInstructions(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR IMAGENS DO CARROSSEL." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "IMAGEM INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare("SELECT r2_key AS r2Key FROM instruction_carousel_images WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ r2Key: string }>();
    if (!row) return jsonResponse({ error: "IMAGEM NÃO ENCONTRADA." }, 404);

    await database.prepare("DELETE FROM instruction_carousel_images WHERE id=?1").bind(id).run();
    const bucket = await documentsBucket();
    await bucket.delete(row.r2Key).catch((error) => {
      console.error("Imagem do carrossel excluída do banco, mas o objeto R2 ficou órfão.", error);
    });
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a imagem do carrossel.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A IMAGEM." }, 500);
  }
}
