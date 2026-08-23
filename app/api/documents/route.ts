import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import {
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  PDF_CONTENT_TYPE,
  canManageDocuments,
  documentActor,
  documentFolder,
  documentJson,
  documentSameOrigin,
  documentsBucket,
  looksLikePdf,
  safeDocumentText,
  safeR2FileName,
  validPdfName,
  type DocumentRow,
} from "./shared";

type StagedDocument = {
  fileName: string;
  contentType: string;
  fileSize: number;
  numberOfParts: number;
  folderId: string;
};

type JsonMap = Record<string, unknown>;

const DOCUMENT_CHUNK_SIZE = PDF_CHUNK_SIZE;
const MAX_DOCUMENT_SIZE = MAX_PDF_SIZE;

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function sessionIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function stagingPrefix(sessionId: string) {
  return `documents/_pending/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${stagingPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${stagingPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

function pdfMetadataError(metadata: StagedDocument) {
  if (!validPdfName(metadata.fileName)) return "SELECIONE UM ARQUIVO PDF VÁLIDO.";
  if (metadata.contentType !== PDF_CONTENT_TYPE) return "APENAS ARQUIVOS PDF SÃO ACEITOS.";
  if (!Number.isInteger(metadata.fileSize) || metadata.fileSize <= 0) {
    return "O ARQUIVO PDF ESTÁ VAZIO OU É INVÁLIDO.";
  }
  if (metadata.fileSize > MAX_DOCUMENT_SIZE) {
    return "O DOCUMENTO DEVE TER NO MÁXIMO 25 MB.";
  }
  if (!documentFolder(metadata.folderId)) return "PASTA DE DOCUMENTOS INVÁLIDA.";
  return "";
}

async function readMetadata(bucket: R2Bucket, sessionId: string) {
  const object = await bucket.get(metadataKey(sessionId));
  if (!object) return null;
  return JSON.parse(await object.text()) as StagedDocument;
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
  const metadata: StagedDocument = {
    fileName: safeDocumentText(payload.fileName, 181),
    contentType: safeDocumentText(payload.contentType, 80).toLowerCase(),
    fileSize: numberValue(payload.fileSize),
    numberOfParts: numberValue(payload.numberOfParts),
    folderId: safeDocumentText(payload.folder, 80),
  };
  const error = pdfMetadataError(metadata);
  if (error) return documentJson({ error }, 400);

  const expectedParts = Math.ceil(metadata.fileSize / DOCUMENT_CHUNK_SIZE);
  if (!Number.isInteger(metadata.numberOfParts) || metadata.numberOfParts !== expectedParts) {
    return documentJson({ error: "A DIVISÃO DO PDF É INVÁLIDA. SELECIONE-O NOVAMENTE." }, 400);
  }

  const sessionId = crypto.randomUUID();
  const bucket = await documentsBucket();
  await bucket.put(metadataKey(sessionId), JSON.stringify(metadata), {
    httpMetadata: { contentType: "application/json" },
  });
  return documentJson({ session: { id: sessionId, numberOfParts: expectedParts } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = safeDocumentText(request.headers.get("x-document-upload-id"), 80);
  const partNumber = numberValue(request.headers.get("x-document-part-number"));
  if (!sessionIdIsValid(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
    return documentJson({ error: "UMA PARTE DO PDF É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  const metadata = await readMetadata(bucket, sessionId);
  if (!metadata) {
    return documentJson({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
  }
  if (partNumber > metadata.numberOfParts) {
    return documentJson({ error: "UMA PARTE DO PDF É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }

  const bytes = await request.arrayBuffer();
  const expectedSize =
    partNumber === metadata.numberOfParts
      ? metadata.fileSize - (metadata.numberOfParts - 1) * DOCUMENT_CHUNK_SIZE
      : DOCUMENT_CHUNK_SIZE;
  if (bytes.byteLength !== expectedSize || bytes.byteLength > DOCUMENT_CHUNK_SIZE) {
    return documentJson({ error: "UMA PARTE DO PDF CHEGOU INCOMPLETA. TENTE NOVAMENTE." }, 400);
  }

  await bucket.put(partKey(sessionId, partNumber), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return documentJson({ partNumber });
}

async function completeSession(request: Request, payload: JsonMap) {
  const sessionId = safeDocumentText(payload.sessionId, 80);
  if (!sessionIdIsValid(sessionId)) {
    return documentJson({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 400);
  }

  const bucket = await documentsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    if (!metadata) {
      return documentJson({ error: "O ENVIO DO PDF EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
    }
    const metadataError = pdfMetadataError(metadata);
    if (metadataError) return documentJson({ error: metadataError }, 400);

    const parts: ArrayBuffer[] = [];
    let receivedSize = 0;
    for (let partNumber = 1; partNumber <= metadata.numberOfParts; partNumber += 1) {
      const object = await bucket.get(partKey(sessionId, partNumber));
      if (!object) {
        return documentJson({ error: "O ENVIO DO PDF FICOU INCOMPLETO. TENTE NOVAMENTE." }, 400);
      }
      const part = await object.arrayBuffer();
      receivedSize += part.byteLength;
      parts.push(part);
    }
    if (receivedSize !== metadata.fileSize) {
      return documentJson({ error: "O TAMANHO FINAL DO PDF NÃO CONFERE. TENTE NOVAMENTE." }, 400);
    }

    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    if (!looksLikePdf(bytes)) {
      return documentJson({ error: "O ARQUIVO NÃO POSSUI UMA ESTRUTURA PDF VÁLIDA." }, 400);
    }

    const folder = documentFolder(metadata.folderId);
    if (!folder) return documentJson({ error: "PASTA DE DOCUMENTOS INVÁLIDA." }, 400);
    const actor = documentActor(request);
    const id = crypto.randomUUID();
    const r2Key = `documents/${folder.id}/${id}/${safeR2FileName(metadata.fileName)}`;
    const createdAt = new Date().toISOString();

    await bucket.put(r2Key, bytes, {
      httpMetadata: { contentType: PDF_CONTENT_TYPE },
      customMetadata: {
        documentId: id,
        uploadedBy: actor.id,
        uploadedAt: createdAt,
      },
    });

    try {
      const database = await getD1();
      await database
        .prepare(
          `INSERT INTO documents
             (id, file_name, category, folder, subfolder, r2_key, content_type,
              size_bytes, uploaded_by, uploaded_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .bind(
          id,
          metadata.fileName,
          folder.category,
          folder.folder,
          folder.subfolder,
          r2Key,
          PDF_CONTENT_TYPE,
          metadata.fileSize,
          actor.id,
          actor.displayName || actor.username,
          createdAt,
        )
        .run();
    } catch (error) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw error;
    }

    return documentJson({ document: { id, fileName: metadata.fileName, folder: folder.id } }, 201);
  } finally {
    await removeStaged(bucket, sessionId).catch(() => undefined);
  }
}

async function cancelSession(payload: JsonMap) {
  const sessionId = safeDocumentText(payload.sessionId, 80);
  if (sessionIdIsValid(sessionId)) {
    const bucket = await documentsBucket();
    await removeStaged(bucket, sessionId);
  }
  return new Response(null, { status: 204 });
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const folder = documentFolder(new URL(request.url).searchParams.get("folder"));
  if (!folder) return documentJson({ error: "PASTA DE DOCUMENTOS INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, file_name AS fileName, category, folder, subfolder,
                r2_key AS r2Key, content_type AS contentType,
                size_bytes AS sizeBytes, uploaded_by AS uploadedBy,
                uploaded_by_name AS uploadedByName, created_at AS createdAt
         FROM documents
         WHERE folder=?1 AND subfolder=?2
         ORDER BY created_at DESC, file_name ASC`,
      )
      .bind(folder.folder, folder.subfolder)
      .all<DocumentRow>();
    const documents = result.results.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      category: row.category,
      folder: row.folder,
      subfolder: row.subfolder,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedBy: row.uploadedBy,
      uploadedByName: row.uploadedByName,
      createdAt: row.createdAt,
      folderId: folder.id,
      viewUrl: `/api/documents/file?id=${encodeURIComponent(row.id)}`,
      downloadUrl: `/api/documents/file?id=${encodeURIComponent(row.id)}&download=1`,
    }));
    return documentJson({ folder, documents });
  } catch (error) {
    console.error("Não foi possível listar os documentos.", error);
    return documentJson({ error: "NÃO FOI POSSÍVEL CARREGAR OS DOCUMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = documentActor(request);
  if (!canManageDocuments(actor)) {
    return documentJson({ error: "APENAS O ADMINISTRADOR PODE ADICIONAR DOCUMENTOS." }, 403);
  }
  if (!documentSameOrigin(request)) {
    return documentJson({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await request.json()) as JsonMap;
      const action = safeDocumentText(payload.action, 20);
      if (action === "create") return await createSession(payload);
      if (action === "complete") return await completeSession(request, payload);
      if (action === "cancel") return await cancelSession(payload);
      return documentJson({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
    }
    if (contentType.includes("application/octet-stream")) {
      return await storeChunk(request);
    }
    return documentJson({ error: "TIPO DE REQUISIÇÃO INVÁLIDO." }, 400);
  } catch (error) {
    console.error("Não foi possível processar o documento.", error);
    return documentJson({ error: "NÃO FOI POSSÍVEL ENVIAR O DOCUMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = documentActor(request);
  if (!canManageDocuments(actor)) {
    return documentJson({ error: "APENAS O ADMINISTRADOR PODE EXCLUIR DOCUMENTOS." }, 403);
  }
  if (!documentSameOrigin(request)) {
    return documentJson({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const id = safeDocumentText(new URL(request.url).searchParams.get("id"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return documentJson({ error: "DOCUMENTO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare("SELECT r2_key AS r2Key FROM documents WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ r2Key: string }>();
    if (!row) return documentJson({ error: "DOCUMENTO NÃO ENCONTRADO." }, 404);

    await database.prepare("DELETE FROM documents WHERE id=?1").bind(id).run();
    const bucket = await documentsBucket();
    await bucket.delete(row.r2Key).catch((error) => {
      console.error("Documento excluído do banco, mas o objeto R2 ficou órfão.", error);
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Não foi possível excluir o documento.", error);
    return documentJson({ error: "NÃO FOI POSSÍVEL EXCLUIR O DOCUMENTO." }, 500);
  }
}
