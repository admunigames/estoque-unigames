import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import {
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  PDF_CONTENT_TYPE,
  documentsBucket,
  looksLikePdf,
  safeR2FileName,
  validPdfName,
} from "../../../../documents/shared";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type Identity,
  type JsonMap,
} from "../../../shared";

// Anexos (documentos PDF) de uma declaração de shopping. Mesmo fluxo em
// partes (create/chunk/complete/cancel) da Folha e das Notas de O.S. — o
// Worker limita o corpo por requisição, então o PDF sobe em pedaços de
// 512 KB para uma área de staging no R2 e só é montado/validado no complete.

type StagedAttachment = {
  declarationId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  numberOfParts: number;
};

const idIsValid = (value: string) => /^[0-9a-f-]{36}$/i.test(value);
const numberValue = (value: unknown) => (typeof value === "number" ? value : Number(value));

const stagingPrefix = (sessionId: string) => `mall-declarations/_pending/${sessionId}`;
const metadataKey = (sessionId: string) => `${stagingPrefix(sessionId)}/metadata.json`;
const partKey = (sessionId: string, partNumber: number) =>
  `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;

function metadataError(metadata: StagedAttachment) {
  if (!idIsValid(metadata.declarationId)) return "DECLARAÇÃO INVÁLIDA.";
  if (!validPdfName(metadata.fileName)) return "SELECIONE UM ARQUIVO PDF VÁLIDO.";
  if (metadata.contentType !== PDF_CONTENT_TYPE) return "APENAS ARQUIVOS PDF SÃO ACEITOS.";
  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize <= 0) return "O ARQUIVO PDF ESTÁ VAZIO OU É INVÁLIDO.";
  if (metadata.fileSize > MAX_PDF_SIZE) return "O DOCUMENTO DEVE TER NO MÁXIMO 25 MB.";
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
    const listed = await bucket.list({ prefix: `${stagingPrefix(sessionId)}/`, limit: 1000, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function declarationExists(declarationId: string) {
  const database = await getD1();
  return database
    .prepare("SELECT id FROM finance_mall_declarations WHERE id=?1 LIMIT 1")
    .bind(declarationId)
    .first<{ id: string }>();
}

async function createSession(declarationId: string, payload: JsonMap) {
  const metadata: StagedAttachment = {
    declarationId,
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: numberValue(payload.fileSize),
    numberOfParts: numberValue(payload.numberOfParts),
  };
  const error = metadataError(metadata);
  if (error) return jsonResponse({ error }, 400);
  if (!(await declarationExists(declarationId))) return jsonResponse({ error: "DECLARAÇÃO NÃO ENCONTRADA." }, 404);

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
  const sessionId = safeText(request.headers.get("x-invoice-upload-id"), 80);
  const partNumber = numberValue(request.headers.get("x-invoice-part-number"));
  if (!idIsValid(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
    return jsonResponse({ error: "UMA PARTE DO PDF É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }
  const bucket = await documentsBucket();
  const metadata = await readMetadata(bucket, sessionId);
  if (!metadata) return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
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

async function completeSession(payload: JsonMap, actor: Identity) {
  const sessionId = safeText(payload.sessionId, 80);
  if (!idIsValid(sessionId)) return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 400);
  const bucket = await documentsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    if (!metadata) return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
    const error = metadataError(metadata);
    if (error) return jsonResponse({ error }, 400);
    if (!(await declarationExists(metadata.declarationId))) {
      return jsonResponse({ error: "DECLARAÇÃO NÃO ENCONTRADA." }, 404);
    }

    const parts: ArrayBuffer[] = [];
    let receivedSize = 0;
    for (let partNumber = 1; partNumber <= metadata.numberOfParts; partNumber += 1) {
      const object = await bucket.get(partKey(sessionId, partNumber));
      if (!object) return jsonResponse({ error: "O ENVIO DO PDF FICOU INCOMPLETO. TENTE NOVAMENTE." }, 400);
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

    const attachmentId = crypto.randomUUID();
    const r2Key = `mall-declarations/${metadata.declarationId}/${attachmentId}-${safeR2FileName(metadata.fileName)}`;
    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: PDF_CONTENT_TYPE },
      customMetadata: {
        declarationId: metadata.declarationId,
        uploadedBy: actor.id,
        uploadedAt: new Date().toISOString(),
      },
    });

    const database = await getD1();
    try {
      await database
        .prepare(
          `INSERT INTO finance_mall_declaration_attachments
            (id, declaration_id, file_name, r2_key, content_type, size_bytes,
             uploaded_by, uploaded_by_name, uploaded_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP)`,
        )
        .bind(
          attachmentId,
          metadata.declarationId,
          metadata.fileName,
          r2Key,
          PDF_CONTENT_TYPE,
          metadata.fileSize,
          actor.id,
          actor.displayName || "Administrador",
        )
        .run();
    } catch (dbError) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw dbError;
    }
    return jsonResponse({ attached: true, id: attachmentId, fileName: metadata.fileName }, 201);
  } finally {
    await removeStaged(bucket, sessionId).catch(() => undefined);
  }
}

async function cancelSession(payload: JsonMap) {
  const sessionId = safeText(payload.sessionId, 80);
  if (idIsValid(sessionId)) {
    const bucket = await documentsBucket();
    await removeStaged(bucket, sessionId);
  }
  return new Response(null, { status: 204 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const { id } = await context.params;
  const declarationId = safeText(id, 80);
  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT id, file_name AS fileName, size_bytes AS sizeBytes,
                uploaded_by_name AS uploadedByName, uploaded_at AS uploadedAt
         FROM finance_mall_declaration_attachments
         WHERE declaration_id=?1 ORDER BY uploaded_at DESC`,
      )
      .bind(declarationId)
      .all();
    return jsonResponse({ attachments: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os anexos da declaração.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS ANEXOS." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR ARQUIVOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const declarationId = safeText(id, 80);
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await request.json()) as JsonMap;
      const action = safeText(payload.action, 20);
      if (action === "create") return await createSession(declarationId, payload);
      if (action === "complete") return await completeSession(payload, actor);
      if (action === "cancel") return await cancelSession(payload);
      return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
    }
    if (contentType.includes("application/octet-stream")) {
      return await storeChunk(request);
    }
    return jsonResponse({ error: "TIPO DE REQUISIÇÃO INVÁLIDO." }, 400);
  } catch (error) {
    console.error("Não foi possível processar o anexo da declaração.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O PDF." }, 500);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REMOVER ANEXOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const declarationId = safeText(id, 80);
  const attachmentId = safeText(new URL(request.url).searchParams.get("attachmentId"), 80);
  if (!attachmentId) return jsonResponse({ error: "ANEXO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    const row = await database
      .prepare(
        "SELECT r2_key AS r2Key FROM finance_mall_declaration_attachments WHERE id=?1 AND declaration_id=?2",
      )
      .bind(attachmentId, declarationId)
      .first<{ r2Key: string }>();
    if (!row) return jsonResponse({ error: "ANEXO NÃO ENCONTRADO." }, 404);
    await database
      .prepare("DELETE FROM finance_mall_declaration_attachments WHERE id=?1")
      .bind(attachmentId)
      .run();
    if (row.r2Key) {
      const bucket = await documentsBucket();
      await bucket.delete(row.r2Key).catch(() => undefined);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível remover o anexo da declaração.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REMOVER O ANEXO." }, 500);
  }
}
