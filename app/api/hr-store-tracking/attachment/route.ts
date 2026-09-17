import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DEFAULT_ATTACHMENT_CONTENT_TYPE,
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  documentsBucket,
  safeR2FileName,
  validAttachmentName,
} from "../../documents/shared";
import {
  actorName,
  canManageStoreTracking,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type Identity,
  type JsonMap,
} from "../shared";

// Ata de presença assinada (PDI de líderes ou acompanhamento por loja).
// Mesmo fluxo em partes (create/chunk/complete/cancel) de app/api/hr-payroll/
// attachment/route.ts, com um "kind" a mais pra apontar qual das duas
// tabelas recebe o anexo. Aceita PDF ou imagem (restrição do requisito,
// diferente do precedente que só aceitava PDF).

const TABLES: Record<string, string> = {
  leader: "hr_leader_pdi",
  store: "hr_store_tracking",
};

const ACCEPTED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

type StagedAttachment = {
  kind: string;
  recordId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  numberOfParts: number;
};

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function sessionIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function recordIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function stagingPrefix(sessionId: string) {
  return `hr-store-tracking/_pending/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${stagingPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

function attachmentMetadataError(metadata: StagedAttachment) {
  if (!TABLES[metadata.kind]) return "TIPO DE REGISTRO INVÁLIDO.";
  if (!recordIdIsValid(metadata.recordId)) return "REGISTRO INVÁLIDO.";
  if (!validAttachmentName(metadata.fileName)) return "SELECIONE UM ARQUIVO VÁLIDO.";
  if (metadata.contentType && !ACCEPTED_CONTENT_TYPES.has(metadata.contentType)) {
    return "ANEXE UM ARQUIVO EM PDF OU IMAGEM (JPG, PNG, WEBP).";
  }
  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize <= 0) {
    return "O ARQUIVO ESTÁ VAZIO OU É INVÁLIDO.";
  }
  if (metadata.fileSize > MAX_PDF_SIZE) {
    return "A ATA DEVE TER NO MÁXIMO 25 MB.";
  }
  return "";
}

async function readMetadata(bucket: R2Bucket, sessionId: string) {
  const object = await bucket.get(metadataKey(sessionId));
  if (!object) return null;
  return JSON.parse(await object.text()) as StagedAttachment;
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
  const metadata: StagedAttachment = {
    kind: safeText(payload.kind, 20),
    recordId: safeText(payload.id, 80),
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: numberValue(payload.fileSize),
    numberOfParts: numberValue(payload.numberOfParts),
  };
  const error = attachmentMetadataError(metadata);
  if (error) return jsonResponse({ error }, 400);

  const database = await getD1();
  const table = TABLES[metadata.kind];
  const existing = await database
    .prepare(`SELECT id FROM ${table} WHERE id=?1 LIMIT 1`)
    .bind(metadata.recordId)
    .first<{ id: string }>();
  if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);

  const expectedParts = Math.ceil(metadata.fileSize / PDF_CHUNK_SIZE);
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
  const sessionId = safeText(request.headers.get("x-hr-store-tracking-upload-id"), 80);
  const partNumber = numberValue(request.headers.get("x-hr-store-tracking-part-number"));
  if (!sessionIdIsValid(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
    return jsonResponse({ error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  const metadata = await readMetadata(bucket, sessionId);
  if (!metadata) {
    return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
  }
  if (partNumber > metadata.numberOfParts) {
    return jsonResponse({ error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bytes = await request.arrayBuffer();
  const expectedSize =
    partNumber === metadata.numberOfParts
      ? metadata.fileSize - (metadata.numberOfParts - 1) * PDF_CHUNK_SIZE
      : PDF_CHUNK_SIZE;
  if (bytes.byteLength !== expectedSize || bytes.byteLength > PDF_CHUNK_SIZE) {
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
    return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    if (!metadata) {
      return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
    }
    const metadataError = attachmentMetadataError(metadata);
    if (metadataError) return jsonResponse({ error: metadataError }, 400);

    const database = await getD1();
    const table = TABLES[metadata.kind];
    const existing = await database
      .prepare(`SELECT id, attachment_r2_key AS attachmentR2Key FROM ${table} WHERE id=?1 LIMIT 1`)
      .bind(metadata.recordId)
      .first<{ id: string; attachmentR2Key: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);

    const parts: ArrayBuffer[] = [];
    let receivedSize = 0;
    for (let partNumber = 1; partNumber <= metadata.numberOfParts; partNumber += 1) {
      const object = await bucket.get(partKey(sessionId, partNumber));
      if (!object) {
        return jsonResponse({ error: "O ENVIO DO ARQUIVO FICOU INCOMPLETO. TENTE NOVAMENTE." }, 400);
      }
      const part = await object.arrayBuffer();
      receivedSize += part.byteLength;
      parts.push(part);
    }
    if (receivedSize !== metadata.fileSize) {
      return jsonResponse({ error: "O TAMANHO FINAL DO ARQUIVO NÃO CONFERE. TENTE NOVAMENTE." }, 400);
    }

    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());

    const attachedAt = new Date().toISOString();
    const r2Key = `hr-store-tracking/${metadata.kind}/${metadata.recordId}/${safeR2FileName(metadata.fileName)}`;

    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: metadata.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE },
      customMetadata: {
        recordId: metadata.recordId,
        uploadedBy: actor.id,
        uploadedAt: attachedAt,
      },
    });

    try {
      await database
        .prepare(
          `UPDATE ${table}
           SET attachment_file_name=?1, attachment_r2_key=?2, attachment_size_bytes=?3,
               updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
           WHERE id=?6`,
        )
        .bind(
          metadata.fileName,
          r2Key,
          metadata.fileSize,
          actor.id,
          actorName(actor),
          metadata.recordId,
        )
        .run();
    } catch (error) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw error;
    }

    if (existing.attachmentR2Key && existing.attachmentR2Key !== r2Key) {
      await bucket.delete(existing.attachmentR2Key).catch(() => undefined);
    }

    return jsonResponse({ attached: true, id: metadata.recordId, fileName: metadata.fileName }, 201);
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

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR A ATA." }, 403);
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
    console.error("Não foi possível processar a ata de presença.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O ARQUIVO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REMOVER A ATA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const url = new URL(request.url);
  const kind = safeText(url.searchParams.get("kind"), 20);
  const id = safeText(url.searchParams.get("id"), 80);
  const table = TABLES[kind];
  if (!table || !recordIdIsValid(id)) return jsonResponse({ error: "REGISTRO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare(`SELECT attachment_r2_key AS attachmentR2Key FROM ${table} WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<{ attachmentR2Key: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database
      .prepare(
        `UPDATE ${table}
         SET attachment_file_name='', attachment_r2_key='', attachment_size_bytes=0,
             updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
      )
      .bind(actor.id, actorName(actor), id)
      .run();
    if (existing.attachmentR2Key) {
      const bucket = await documentsBucket();
      await bucket.delete(existing.attachmentR2Key).catch(() => undefined);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível remover a ata de presença.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REMOVER A ATA." }, 500);
  }
}
