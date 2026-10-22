import { getD1 } from "../../../../../db";
import {
  DEFAULT_ATTACHMENT_CONTENT_TYPE,
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  documentsBucket,
  safeR2FileName,
  validAttachmentName,
} from "../../../documents/shared";
import { jsonResponse, ownerRma, safeText, writeGuard, type Actor } from "../shared";

// Assistência > RMA: anexo do RMA, de uma atualização ou de um crédito (PDF,
// foto, NF), em partes de 512 KB — mesmo fluxo do Inventário.
//   POST {action:"create", ownerType:"rma"|"update"|"credit", ownerId, fileName, contentType, fileSize, numberOfParts}
//   POST (octet-stream, x-rma-upload-id, x-rma-part-number)
//   POST {action:"complete", sessionId} / {action:"cancel", sessionId}
//   DELETE {attachmentId}

type Staged = { ownerType: string; ownerId: string; rmaId: string; fileName: string; contentType: string; fileSize: number; numberOfParts: number };

const SESSION = /^[0-9a-f-]{36}$/i;
const prefix = (sessionId: string) => `rma/_pending/${sessionId}`;
const metaKey = (sessionId: string) => `${prefix(sessionId)}/metadata.json`;
const partKey = (sessionId: string, part: number) => `${prefix(sessionId)}/parts/${String(part).padStart(4, "0")}`;

function metadataError(meta: Staged) {
  if (!meta.ownerId) return "REGISTRO INVÁLIDO.";
  if (!validAttachmentName(meta.fileName)) return "SELECIONE UM ARQUIVO VÁLIDO.";
  if (!Number.isInteger(meta.fileSize) || meta.fileSize <= 0) return "O ARQUIVO ESTÁ VAZIO OU É INVÁLIDO.";
  if (meta.fileSize > MAX_PDF_SIZE) return "O ARQUIVO DEVE TER NO MÁXIMO 25 MB.";
  return "";
}

async function removeStaged(bucket: R2Bucket, sessionId: string) {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${prefix(sessionId)}/`, limit: 1000, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function readMeta(bucket: R2Bucket, sessionId: string) {
  const object = await bucket.get(metaKey(sessionId));
  return object ? (JSON.parse(await object.text()) as Staged) : null;
}

async function create(payload: Record<string, unknown>, actor: Actor) {
  const meta: Staged = {
    ownerType: safeText(payload.ownerType, 10),
    ownerId: safeText(payload.ownerId, 80),
    rmaId: "",
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: Number(payload.fileSize),
    numberOfParts: Number(payload.numberOfParts),
  };
  const error = metadataError(meta);
  if (error) return jsonResponse({ error }, 400);
  const database = await getD1();
  const rmaId = await ownerRma(database, actor, meta.ownerType, meta.ownerId);
  if (rmaId === null) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
  meta.rmaId = rmaId;
  const expected = Math.ceil(meta.fileSize / PDF_CHUNK_SIZE);
  if (meta.numberOfParts !== expected) return jsonResponse({ error: "A DIVISÃO DO ARQUIVO É INVÁLIDA. SELECIONE-O NOVAMENTE." }, 400);
  const sessionId = crypto.randomUUID();
  const bucket = await documentsBucket();
  await bucket.put(metaKey(sessionId), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
  return jsonResponse({ session: { id: sessionId, numberOfParts: expected } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = safeText(request.headers.get("x-rma-upload-id"), 80);
  const part = Number(request.headers.get("x-rma-part-number"));
  if (!SESSION.test(sessionId) || !Number.isInteger(part) || part < 1) {
    return jsonResponse({ error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }
  const bucket = await documentsBucket();
  const meta = await readMeta(bucket, sessionId);
  if (!meta) return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
  if (part > meta.numberOfParts) return jsonResponse({ error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  const bytes = await request.arrayBuffer();
  const expected = part === meta.numberOfParts ? meta.fileSize - (meta.numberOfParts - 1) * PDF_CHUNK_SIZE : PDF_CHUNK_SIZE;
  if (bytes.byteLength !== expected) return jsonResponse({ error: "UMA PARTE DO ARQUIVO CHEGOU INCOMPLETA. TENTE NOVAMENTE." }, 400);
  await bucket.put(partKey(sessionId, part), bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  return jsonResponse({ partNumber: part });
}

async function complete(payload: Record<string, unknown>, actor: Actor) {
  const sessionId = safeText(payload.sessionId, 80);
  if (!SESSION.test(sessionId)) return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 400);
  const bucket = await documentsBucket();
  try {
    const meta = await readMeta(bucket, sessionId);
    if (!meta) return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
    const error = metadataError(meta);
    if (error) return jsonResponse({ error }, 400);
    const database = await getD1();
    if ((await ownerRma(database, actor, meta.ownerType, meta.ownerId)) === null) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    const parts: ArrayBuffer[] = [];
    let size = 0;
    for (let part = 1; part <= meta.numberOfParts; part += 1) {
      const object = await bucket.get(partKey(sessionId, part));
      if (!object) return jsonResponse({ error: "O ENVIO DO ARQUIVO FICOU INCOMPLETO. TENTE NOVAMENTE." }, 400);
      const buffer = await object.arrayBuffer();
      size += buffer.byteLength;
      parts.push(buffer);
    }
    if (size !== meta.fileSize) return jsonResponse({ error: "O TAMANHO FINAL DO ARQUIVO NÃO CONFERE. TENTE NOVAMENTE." }, 400);
    const id = crypto.randomUUID();
    const r2Key = `rma/${meta.rmaId || meta.ownerId}/${id}-${safeR2FileName(meta.fileName)}`;
    const now = new Date().toISOString();
    await bucket.put(r2Key, new Uint8Array(await new Blob(parts).arrayBuffer()), {
      httpMetadata: { contentType: meta.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE },
    });
    try {
      await database
        .prepare(
          `INSERT INTO rma_attachments (id, owner_type, owner_id, rma_id, file_name, r2_key, size_bytes, content_type, deleted,
                                        uploaded_by, uploaded_by_name, uploaded_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11)`,
        )
        .bind(id, meta.ownerType, meta.ownerId, meta.rmaId, meta.fileName, r2Key, meta.fileSize,
          meta.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE, actor.id, actor.displayName, now)
        .run();
    } catch (insertError) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw insertError;
    }
    return jsonResponse({ attached: true, id, fileName: meta.fileName }, 201);
  } finally {
    await removeStaged(bucket, sessionId).catch(() => undefined);
  }
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  const payload = contentType.includes("application/octet-stream")
    ? {}
    : ((await request.clone().json().catch(() => ({}))) as Record<string, unknown>);
  // Anexo de crédito pede rma:finance; os demais, rma:edit.
  const checked = writeGuard(request, payload.ownerType === "credit" ? "finance" : "edit", "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR ARQUIVOS NO RMA.");
  if ("error" in checked) return checked.error;
  try {
    if (contentType.includes("application/octet-stream")) return await storeChunk(request);
    const action = safeText(payload.action, 20);
    if (action === "create") return await create(payload, checked.actor);
    if (action === "complete") return await complete(payload, checked.actor);
    if (action === "cancel") {
      const sessionId = safeText(payload.sessionId, 80);
      if (SESSION.test(sessionId)) await removeStaged(await documentsBucket(), sessionId);
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível anexar o arquivo no RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O ARQUIVO." }, 500);
  }
}

// Tira o anexo da lista (deleted=1); o arquivo fica no R2 como histórico.
export async function DELETE(request: Request) {
  const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const database = await getD1();
  const attachmentId = safeText(body.attachmentId, 80);
  const row = attachmentId
    ? await database
      .prepare("SELECT owner_type AS ownerType, owner_id AS ownerId FROM rma_attachments WHERE id=?1 AND deleted=0")
      .bind(attachmentId)
      .first<{ ownerType: string; ownerId: string }>()
    : null;
  const checked = writeGuard(request, row?.ownerType === "credit" ? "finance" : "edit", "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR O ANEXO.");
  if ("error" in checked) return checked.error;
  try {
    if (!row || (await ownerRma(database, checked.actor, row.ownerType, row.ownerId)) === null) {
      return jsonResponse({ error: "ANEXO NÃO ENCONTRADO." }, 404);
    }
    await database.prepare("UPDATE rma_attachments SET deleted=1 WHERE id=?1").bind(attachmentId).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o anexo do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ANEXO." }, 500);
  }
}
