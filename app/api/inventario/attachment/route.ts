import { getD1 } from "../../../../db";
import {
  DEFAULT_ATTACHMENT_CONTENT_TYPE,
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  documentsBucket,
  safeR2FileName,
  validAttachmentName,
} from "../../documents/shared";
import { findInventory, guard, jsonResponse, safeText, type Actor } from "../shared";

// Estoque > Inventário > RECONTAGEM: anexa a recontagem da loja escaneada
// (PDF/foto) em partes de 512 KB, mesmo fluxo das Notas de O.S.
//   POST {action:"create", id, fileName, contentType, fileSize, numberOfParts}
//   POST (octet-stream, x-inventory-upload-id, x-inventory-part-number)
//   POST {action:"complete", sessionId} / {action:"cancel", sessionId}
//   DELETE {id, attachmentId}

type Staged = { inventoryId: string; fileName: string; contentType: string; fileSize: number; numberOfParts: number };

const SESSION = /^[0-9a-f-]{36}$/i;
const prefix = (sessionId: string) => `inventario/_pending/${sessionId}`;
const metaKey = (sessionId: string) => `${prefix(sessionId)}/metadata.json`;
const partKey = (sessionId: string, part: number) => `${prefix(sessionId)}/parts/${String(part).padStart(4, "0")}`;

function metadataError(meta: Staged) {
  if (!meta.inventoryId) return "INVENTÁRIO INVÁLIDO.";
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
    inventoryId: safeText(payload.id, 80),
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: Number(payload.fileSize),
    numberOfParts: Number(payload.numberOfParts),
  };
  const error = metadataError(meta);
  if (error) return jsonResponse({ error }, 400);
  const database = await getD1();
  if (!(await findInventory(database, actor, meta.inventoryId))) return jsonResponse({ error: "INVENTÁRIO NÃO ENCONTRADO." }, 404);
  const expected = Math.ceil(meta.fileSize / PDF_CHUNK_SIZE);
  if (meta.numberOfParts !== expected) return jsonResponse({ error: "A DIVISÃO DO ARQUIVO É INVÁLIDA. SELECIONE-O NOVAMENTE." }, 400);
  const sessionId = crypto.randomUUID();
  const bucket = await documentsBucket();
  await bucket.put(metaKey(sessionId), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
  return jsonResponse({ session: { id: sessionId, numberOfParts: expected } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = safeText(request.headers.get("x-inventory-upload-id"), 80);
  const part = Number(request.headers.get("x-inventory-part-number"));
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
    if (!(await findInventory(database, actor, meta.inventoryId))) return jsonResponse({ error: "INVENTÁRIO NÃO ENCONTRADO." }, 404);
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
    const r2Key = `inventario/${meta.inventoryId}/${id}-${safeR2FileName(meta.fileName)}`;
    const now = new Date().toISOString();
    await bucket.put(r2Key, new Uint8Array(await new Blob(parts).arrayBuffer()), {
      httpMetadata: { contentType: meta.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE },
    });
    try {
      await database
        .prepare(
          `INSERT INTO inventory_attachments (id, inventory_id, file_name, r2_key, size_bytes, content_type, deleted, uploaded_by, uploaded_by_name, uploaded_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)`,
        )
        .bind(id, meta.inventoryId, meta.fileName, r2Key, meta.fileSize, meta.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
          actor.id, actor.displayName, now)
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
  const checked = guard(request, ["count", "manage"], "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR A RECONTAGEM.");
  if ("error" in checked) return checked.error;
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/octet-stream")) return await storeChunk(request);
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
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
    console.error("Não foi possível anexar a recontagem do inventário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O ARQUIVO." }, 500);
  }
}

// Tira o anexo da lista (deleted=1); o arquivo fica no R2 como histórico.
export async function DELETE(request: Request) {
  const checked = guard(request, ["manage"], "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR O ANEXO.");
  if ("error" in checked) return checked.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const database = await getD1();
    const inventory = await findInventory(database, checked.actor, safeText(body.id, 80));
    if (!inventory) return jsonResponse({ error: "INVENTÁRIO NÃO ENCONTRADO." }, 404);
    const row = await database
      .prepare("UPDATE inventory_attachments SET deleted=1 WHERE id=?1 AND inventory_id=?2 RETURNING id")
      .bind(safeText(body.attachmentId, 80), inventory.id)
      .first<{ id: string }>();
    if (!row) return jsonResponse({ error: "ANEXO NÃO ENCONTRADO." }, 404);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o anexo do inventário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ANEXO." }, 500);
  }
}
