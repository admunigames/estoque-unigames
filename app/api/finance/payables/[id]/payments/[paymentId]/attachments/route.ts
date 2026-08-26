import { getD1 } from "../../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../../lib/notion";
import {
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  PDF_CONTENT_TYPE,
  documentsBucket,
  looksLikePdf,
  safeR2FileName,
  validPdfName,
} from "../../../../../../documents/shared";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../../../shared";
import { assertAccess, loadPayable } from "../../../../shared";

// Anexo de comprovante de UM pagamento de accounts_payable — tabela e
// mecanismo GENÉRICOS (accounts_payable_payment_attachments), não
// exclusivos de Fornecedores em Aberto, mas usados primeiro por ela.
// Mesmo esquema de upload chunked em R2 já usado pelas NFs (ver
// app/api/finance/invoices/[id]/attachments/route.ts) — reaproveitado quase
// literalmente, trocando só a tabela/prefixo de chave R2 e a checagem de
// acesso (aqui é a de Contas a Pagar, não a de NF).

type StagedPaymentAttachment = {
  payableId: string;
  paymentId: string;
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

function stagingPrefix(sessionId: string) {
  return `payable-payments/_pending/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${stagingPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

function metadataError(metadata: StagedPaymentAttachment) {
  if (!validPdfName(metadata.fileName)) return "SELECIONE UM ARQUIVO PDF VÁLIDO.";
  if (metadata.contentType !== PDF_CONTENT_TYPE) return "APENAS ARQUIVOS PDF SÃO ACEITOS.";
  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize <= 0) return "O ARQUIVO PDF ESTÁ VAZIO OU É INVÁLIDO.";
  if (metadata.fileSize > MAX_PDF_SIZE) return "O DOCUMENTO DEVE TER NO MÁXIMO 25 MB.";
  return "";
}

async function readMetadata(bucket: R2Bucket, sessionId: string) {
  const object = await bucket.get(metadataKey(sessionId));
  if (!object) return null;
  return JSON.parse(await object.text()) as StagedPaymentAttachment;
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

async function createSession(payload: JsonMap) {
  const metadata: StagedPaymentAttachment = {
    payableId: safeText(payload.payableId, 80),
    paymentId: safeText(payload.paymentId, 80),
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: numberValue(payload.fileSize),
    numberOfParts: numberValue(payload.numberOfParts),
  };
  const error = metadataError(metadata);
  if (error) return jsonResponse({ error }, 400);

  const database = await getD1();
  const payment = await database
    .prepare("SELECT id FROM accounts_payable_payments WHERE id=?1 AND payable_id=?2")
    .bind(metadata.paymentId, metadata.payableId)
    .first<{ id: string }>();
  if (!payment) return jsonResponse({ error: "PAGAMENTO NÃO ENCONTRADO." }, 404);

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
  const sessionId = safeText(request.headers.get("x-payment-upload-id"), 80);
  const partNumber = numberValue(request.headers.get("x-payment-part-number"));
  if (!sessionIdIsValid(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
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

async function completeSession(payload: JsonMap, actor: { id: string; displayName: string }) {
  const sessionId = safeText(payload.sessionId, 80);
  if (!sessionIdIsValid(sessionId)) {
    return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 400);
  }
  const bucket = await documentsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    if (!metadata) return jsonResponse({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
    const error = metadataError(metadata);
    if (error) return jsonResponse({ error }, 400);

    const database = await getD1();
    const payment = await database
      .prepare("SELECT id FROM accounts_payable_payments WHERE id=?1 AND payable_id=?2")
      .bind(metadata.paymentId, metadata.payableId)
      .first<{ id: string }>();
    if (!payment) return jsonResponse({ error: "PAGAMENTO NÃO ENCONTRADO." }, 404);

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
    const r2Key = `payable-payments/${metadata.payableId}/${metadata.paymentId}/${attachmentId}-${safeR2FileName(metadata.fileName)}`;

    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: PDF_CONTENT_TYPE },
      customMetadata: { paymentId: metadata.paymentId, uploadedBy: actor.id, uploadedAt: new Date().toISOString() },
    });

    try {
      await database
        .prepare(
          `INSERT INTO accounts_payable_payment_attachments
            (id, payment_id, r2_key, file_name, content_type, size_bytes, created_by, created_by_name, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP)`,
        )
        .bind(
          attachmentId,
          metadata.paymentId,
          r2Key,
          metadata.fileName,
          PDF_CONTENT_TYPE,
          metadata.fileSize,
          actor.id,
          actor.displayName || "Usuário",
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
  if (sessionIdIsValid(sessionId)) {
    const bucket = await documentsBucket();
    await removeStaged(bucket, sessionId);
  }
  return new Response(null, { status: 204 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string; paymentId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const { id, paymentId } = await context.params;

  try {
    const database = await getD1();
    const payable = await loadPayable(database, id);
    if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);
    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const result = await database
      .prepare(
        `SELECT id, file_name AS fileName, content_type AS contentType, size_bytes AS sizeBytes,
                created_by_name AS createdByName, created_at AS createdAt
         FROM accounts_payable_payment_attachments WHERE payment_id=?1 ORDER BY created_at DESC`,
      )
      .bind(paymentId)
      .all();
    return jsonResponse({ attachments: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os comprovantes do pagamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS COMPROVANTES DO PAGAMENTO." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string; paymentId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR COMPROVANTES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id, paymentId } = await context.params;

  const database = await getD1();
  const payable = await loadPayable(database, id);
  if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const accessError = assertAccess(scopeActor, payable);
  if (accessError) return jsonResponse({ error: accessError }, 403);

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await request.json()) as JsonMap;
      payload.payableId = id;
      payload.paymentId = paymentId;
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
    console.error("Não foi possível processar o comprovante do pagamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O COMPROVANTE." }, 500);
  }
}
