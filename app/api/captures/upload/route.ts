import { unauthorizedResponse } from "../../../lib/notion";
import {
  canAccessCaptures,
  identity,
  jsonResponse,
  photoExtension,
  photoMetaValidationError,
  PHOTO_CHUNK_SIZE,
  sameOrigin,
  uploadsBucket,
  type JsonMap,
} from "../shared";

type StagedPhoto = {
  fileName: string;
  contentType: string;
  fileSize: number;
  numberOfParts: number;
};

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function sessionIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function stagingPrefix(sessionId: string) {
  return `captures/_pending/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${stagingPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

async function readMetadata(bucket: R2Bucket, sessionId: string) {
  const object = await bucket.get(metadataKey(sessionId));
  if (!object) return null;
  return JSON.parse(await object.text()) as StagedPhoto;
}

async function removeStaged(bucket: R2Bucket, sessionId: string) {
  const listed = await bucket.list({ prefix: `${stagingPrefix(sessionId)}/`, limit: 1000 });
  const keys = listed.objects.map((object) => object.key);
  if (keys.length) await bucket.delete(keys);
}

async function createSession(payload: JsonMap) {
  const fileName = textValue(payload.fileName);
  const contentType = textValue(payload.contentType);
  const fileSize = numberValue(payload.fileSize);
  const numberOfParts = numberValue(payload.numberOfParts);
  const error = photoMetaValidationError(fileName, contentType, fileSize);
  if (error) return jsonResponse({ error }, 400);

  const expectedParts = Math.max(1, Math.ceil(fileSize / PHOTO_CHUNK_SIZE));
  if (!Number.isInteger(numberOfParts) || numberOfParts !== expectedParts) {
    return jsonResponse({ error: "A DIVISÃO DA FOTO É INVÁLIDA. SELECIONE-A NOVAMENTE." }, 400);
  }

  const sessionId = crypto.randomUUID();
  const metadata: StagedPhoto = { fileName, contentType, fileSize, numberOfParts };
  const bucket = await uploadsBucket();
  await bucket.put(metadataKey(sessionId), JSON.stringify(metadata), {
    httpMetadata: { contentType: "application/json" },
  });
  return jsonResponse({ session: { id: sessionId, numberOfParts } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = textValue(request.headers.get("x-capture-upload-id"));
  const partNumber = numberValue(request.headers.get("x-capture-part-number"));
  if (!sessionIdIsValid(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
    return jsonResponse({ error: "UMA PARTE DA FOTO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bucket = await uploadsBucket();
  const metadata = await readMetadata(bucket, sessionId);
  if (!metadata) {
    return jsonResponse({ error: "O ENVIO DA FOTO EXPIROU. SELECIONE-A NOVAMENTE." }, 410);
  }
  if (partNumber > metadata.numberOfParts) {
    return jsonResponse({ error: "UMA PARTE DA FOTO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bytes = await request.arrayBuffer();
  const expectedSize =
    partNumber === metadata.numberOfParts
      ? metadata.fileSize - (metadata.numberOfParts - 1) * PHOTO_CHUNK_SIZE
      : PHOTO_CHUNK_SIZE;
  if (bytes.byteLength !== expectedSize || bytes.byteLength > PHOTO_CHUNK_SIZE) {
    return jsonResponse({ error: "UMA PARTE DA FOTO CHEGOU INCOMPLETA. TENTE NOVAMENTE." }, 400);
  }

  await bucket.put(partKey(sessionId, partNumber), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return jsonResponse({ partNumber });
}

async function completeSession(payload: JsonMap) {
  const sessionId = textValue(payload.sessionId);
  if (!sessionIdIsValid(sessionId)) {
    return jsonResponse({ error: "O ENVIO DA FOTO EXPIROU. TENTE NOVAMENTE." }, 400);
  }

  const bucket = await uploadsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    if (!metadata) {
      return jsonResponse({ error: "O ENVIO DA FOTO EXPIROU. TENTE NOVAMENTE." }, 400);
    }
    const parts: ArrayBuffer[] = [];
    for (let partNumber = 1; partNumber <= metadata.numberOfParts; partNumber += 1) {
      const object = await bucket.get(partKey(sessionId, partNumber));
      if (!object) {
        return jsonResponse(
          { error: "O ENVIO DA FOTO FICOU INCOMPLETO. TENTE NOVAMENTE." },
          400,
        );
      }
      parts.push(await object.arrayBuffer());
    }

    const extension = photoExtension(metadata.contentType);
    const photoKey = `captures/${sessionId}/photo.${extension}`;
    const blob = new Blob(parts, { type: metadata.contentType });
    await bucket.put(photoKey, await blob.arrayBuffer(), {
      httpMetadata: { contentType: metadata.contentType },
    });
    return jsonResponse({ photoKey }, 201);
  } finally {
    await removeStaged(bucket, sessionId).catch(() => undefined);
  }
}

async function cancelSession(payload: JsonMap) {
  const sessionId = textValue(payload.sessionId);
  if (sessionIdIsValid(sessionId)) {
    const bucket = await uploadsBucket();
    await removeStaged(bucket, sessionId);
  }
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await request.json()) as JsonMap;
      const action = textValue(payload.action);
      if (action === "create") return await createSession(payload);
      if (action === "complete") return await completeSession(payload);
      if (action === "cancel") return await cancelSession(payload);
      return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
    }
    if (contentType.includes("application/octet-stream")) {
      return await storeChunk(request);
    }
    return jsonResponse({ error: "TIPO DE REQUISIÇÃO INVÁLIDO." }, 400);
  } catch (error) {
    console.error("Não foi possível processar o envio da foto.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENVIAR A FOTO." }, 500);
  }
}
