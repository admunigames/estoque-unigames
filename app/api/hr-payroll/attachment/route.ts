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
import {
  actorName,
  canManagePayroll,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type Identity,
  type JsonMap,
} from "../shared";

// Comprovante de pagamento da folha. Mesmo fluxo em partes (create/chunk/
// complete/cancel) das Notas de O.S. — o Worker tem limite de corpo por
// requisição, então o PDF sobe em pedaços de 512 KB para uma área de
// staging no R2 e só é montado/validado no "complete". Aceita apenas PDF,
// igual ao único precedente do projeto.

type StagedAttachment = {
  entryId: string;
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

function entryIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function stagingPrefix(sessionId: string) {
  return `hr-payroll/_pending/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${stagingPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

function attachmentMetadataError(metadata: StagedAttachment) {
  if (!entryIdIsValid(metadata.entryId)) return "LANÇAMENTO DE FOLHA INVÁLIDO.";
  if (!validPdfName(metadata.fileName)) return "SELECIONE UM ARQUIVO PDF VÁLIDO.";
  if (metadata.contentType !== PDF_CONTENT_TYPE) return "APENAS ARQUIVOS PDF SÃO ACEITOS.";
  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize <= 0) {
    return "O ARQUIVO PDF ESTÁ VAZIO OU É INVÁLIDO.";
  }
  if (metadata.fileSize > MAX_PDF_SIZE) {
    return "O COMPROVANTE DEVE TER NO MÁXIMO 25 MB.";
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
    entryId: safeText(payload.id, 80),
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: numberValue(payload.fileSize),
    numberOfParts: numberValue(payload.numberOfParts),
  };
  const error = attachmentMetadataError(metadata);
  if (error) return jsonResponse({ error }, 400);

  const database = await getD1();
  const existing = await database
    .prepare("SELECT id FROM hr_payroll_entries WHERE id=?1 LIMIT 1")
    .bind(metadata.entryId)
    .first<{ id: string }>();
  if (!existing) return jsonResponse({ error: "LANÇAMENTO DE FOLHA NÃO ENCONTRADO." }, 404);

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
  const sessionId = safeText(request.headers.get("x-hr-payroll-upload-id"), 80);
  const partNumber = numberValue(request.headers.get("x-hr-payroll-part-number"));
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

async function completeSession(payload: JsonMap, actor: Identity) {
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
      .prepare(
        "SELECT id, attachment_r2_key AS attachmentR2Key FROM hr_payroll_entries WHERE id=?1 LIMIT 1",
      )
      .bind(metadata.entryId)
      .first<{ id: string; attachmentR2Key: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO DE FOLHA NÃO ENCONTRADO." }, 404);

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
    const r2Key = `hr-payroll/${metadata.entryId}/${safeR2FileName(metadata.fileName)}`;

    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: PDF_CONTENT_TYPE },
      customMetadata: {
        payrollEntryId: metadata.entryId,
        uploadedBy: actor.id,
        uploadedAt: attachedAt,
      },
    });

    try {
      await database
        .prepare(
          `UPDATE hr_payroll_entries
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
          metadata.entryId,
        )
        .run();
    } catch (error) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw error;
    }

    if (existing.attachmentR2Key && existing.attachmentR2Key !== r2Key) {
      await bucket.delete(existing.attachmentR2Key).catch(() => undefined);
    }

    return jsonResponse({ attached: true, id: metadata.entryId, fileName: metadata.fileName }, 201);
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
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR COMPROVANTES." }, 403);
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
    console.error("Não foi possível processar o comprovante da folha.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O PDF." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REMOVER COMPROVANTES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!entryIdIsValid(id)) return jsonResponse({ error: "LANÇAMENTO DE FOLHA INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare(
        "SELECT attachment_r2_key AS attachmentR2Key FROM hr_payroll_entries WHERE id=?1 LIMIT 1",
      )
      .bind(id)
      .first<{ attachmentR2Key: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO DE FOLHA NÃO ENCONTRADO." }, 404);
    await database
      .prepare(
        `UPDATE hr_payroll_entries
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
    console.error("Não foi possível remover o comprovante da folha.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REMOVER O COMPROVANTE." }, 500);
  }
}
