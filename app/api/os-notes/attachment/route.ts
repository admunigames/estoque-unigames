import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  PDF_CONTENT_TYPE,
  documentsBucket,
  looksLikePdf,
  safeR2FileName,
  validPdfName,
} from "../../documents/shared";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};
type StagedAttachment = {
  osNoteId: string;
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

function can(actor: Identity, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
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

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function sessionIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function osNoteIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function stagingPrefix(sessionId: string) {
  return `os-notes/_pending/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${stagingPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

function attachmentMetadataError(metadata: StagedAttachment) {
  if (!osNoteIdIsValid(metadata.osNoteId)) return "SOLICITAÇÃO INVÁLIDA.";
  if (!validPdfName(metadata.fileName)) return "SELECIONE UM ARQUIVO PDF VÁLIDO.";
  if (metadata.contentType !== PDF_CONTENT_TYPE) return "APENAS ARQUIVOS PDF SÃO ACEITOS.";
  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize <= 0) {
    return "O ARQUIVO PDF ESTÁ VAZIO OU É INVÁLIDO.";
  }
  if (metadata.fileSize > MAX_PDF_SIZE) {
    return "O DOCUMENTO DEVE TER NO MÁXIMO 25 MB.";
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
    osNoteId: safeText(payload.id, 80),
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: numberValue(payload.fileSize),
    numberOfParts: numberValue(payload.numberOfParts),
  };
  const error = attachmentMetadataError(metadata);
  if (error) return jsonResponse({ error }, 400);

  const database = await getD1();
  const existing = await database
    .prepare("SELECT id FROM os_notes WHERE id=?1 LIMIT 1")
    .bind(metadata.osNoteId)
    .first<{ id: string }>();
  if (!existing) return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);

  const expectedParts = Math.ceil(metadata.fileSize / PDF_CHUNK_SIZE);
  if (!Number.isInteger(metadata.numberOfParts) || metadata.numberOfParts !== expectedParts) {
    return jsonResponse({ error: "A DIVISÃO DO PDF É INVÁLIDA. SELECIONE-O NOVAMENTE." }, 400);
  }

  const sessionId = crypto.randomUUID();
  const bucket = await documentsBucket();
  await bucket.put(metadataKey(sessionId), JSON.stringify(metadata), {
    httpMetadata: { contentType: "application/json" },
  });
  return jsonResponse({ session: { id: sessionId, numberOfParts: expectedParts } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = safeText(request.headers.get("x-os-note-upload-id"), 80);
  const partNumber = numberValue(request.headers.get("x-os-note-part-number"));
  if (!sessionIdIsValid(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
    return jsonResponse({ error: "UMA PARTE DO PDF É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  const metadata = await readMetadata(bucket, sessionId);
  if (!metadata) {
    return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
  }
  if (partNumber > metadata.numberOfParts) {
    return jsonResponse({ error: "UMA PARTE DO PDF É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bytes = await request.arrayBuffer();
  const expectedSize =
    partNumber === metadata.numberOfParts
      ? metadata.fileSize - (metadata.numberOfParts - 1) * PDF_CHUNK_SIZE
      : PDF_CHUNK_SIZE;
  if (bytes.byteLength !== expectedSize || bytes.byteLength > PDF_CHUNK_SIZE) {
    return jsonResponse({ error: "UMA PARTE DO PDF CHEGOU INCOMPLETA. TENTE NOVAMENTE." }, 400);
  }

  await bucket.put(partKey(sessionId, partNumber), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return jsonResponse({ partNumber });
}

async function completeSession(request: Request, payload: JsonMap, actor: Identity) {
  const sessionId = safeText(payload.sessionId, 80);
  if (!sessionIdIsValid(sessionId)) {
    return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    if (!metadata) {
      return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
    }
    const metadataError = attachmentMetadataError(metadata);
    if (metadataError) return jsonResponse({ error: metadataError }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, r2_key AS r2Key FROM os_notes WHERE id=?1 LIMIT 1")
      .bind(metadata.osNoteId)
      .first<{ id: string; r2Key: string }>();
    if (!existing) return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);

    const parts: ArrayBuffer[] = [];
    let receivedSize = 0;
    for (let partNumber = 1; partNumber <= metadata.numberOfParts; partNumber += 1) {
      const object = await bucket.get(partKey(sessionId, partNumber));
      if (!object) {
        return jsonResponse({ error: "O ENVIO DO PDF FICOU INCOMPLETO. TENTE NOVAMENTE." }, 400);
      }
      const part = await object.arrayBuffer();
      receivedSize += part.byteLength;
      parts.push(part);
    }
    if (receivedSize !== metadata.fileSize) {
      return jsonResponse({ error: "O TAMANHO FINAL DO PDF NÃO CONFERE. TENTE NOVAMENTE." }, 400);
    }

    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    if (!looksLikePdf(bytes)) {
      return jsonResponse({ error: "O ARQUIVO NÃO POSSUI UMA ESTRUTURA PDF VÁLIDA." }, 400);
    }

    const attachedAt = new Date().toISOString();
    const r2Key = `os-notes/${metadata.osNoteId}/${safeR2FileName(metadata.fileName)}`;

    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: PDF_CONTENT_TYPE },
      customMetadata: {
        osNoteId: metadata.osNoteId,
        uploadedBy: actor.id,
        uploadedAt: attachedAt,
      },
    });

    try {
      await database
        .prepare(
          `UPDATE os_notes
           SET status='attached', file_name=?1, r2_key=?2, size_bytes=?3,
               attached_by=?4, attached_by_name=?5, attached_at=?6, file_removed_at='',
               updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
           WHERE id=?7`,
        )
        .bind(
          metadata.fileName,
          r2Key,
          metadata.fileSize,
          actor.id,
          actor.displayName || "Usuário",
          attachedAt,
          metadata.osNoteId,
        )
        .run();
    } catch (error) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw error;
    }

    if (existing.r2Key && existing.r2Key !== r2Key) {
      await bucket.delete(existing.r2Key).catch(() => undefined);
    }

    return jsonResponse({ attached: true, id: metadata.osNoteId, fileName: metadata.fileName }, 201);
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
  if (!can(actor, "os_notes:attach")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR NOTAS." }, 403);
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
      if (action === "complete") return await completeSession(request, payload, actor);
      if (action === "cancel") return await cancelSession(payload);
      return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
    }
    if (contentType.includes("application/octet-stream")) {
      return await storeChunk(request);
    }
    return jsonResponse({ error: "TIPO DE REQUISIÇÃO INVÁLIDO." }, 400);
  } catch (error) {
    console.error("Não foi possível processar o anexo da nota de O.S.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O PDF." }, 500);
  }
}
