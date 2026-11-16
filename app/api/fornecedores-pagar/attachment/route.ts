import { getD1 } from "../../../../db";
import {
  DEFAULT_ATTACHMENT_CONTENT_TYPE,
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  contentDisposition,
  documentsBucket,
  safeR2FileName,
  validAttachmentName,
} from "../../documents/shared";
import { actorName, guard, jsonResponse, safeText, type Actor } from "../shared";

// Fornecedores a Pagar: anexo do pedido (PDF, JPG/PNG, CSV/XLS/XLSX) no R2,
// em partes de 512 KB — mesmo fluxo do Inventário/RMA.
//   GET  ?id=<anexo>[&download=1]                    (view) abre/baixa
//   POST {action:"create", entryId, fileName, contentType, fileSize, numberOfParts} (create)
//   POST (octet-stream, x-fpg-upload-id, x-fpg-part-number)
//   POST {action:"complete", sessionId} / {action:"cancel", sessionId}
//   DELETE {attachmentId}                            (create) tira da lista; arquivo fica no R2

type Staged = { entryId: string; fileName: string; contentType: string; fileSize: number; numberOfParts: number };

const EXTENSIONS = /\.(pdf|jpe?g|png|csv|xlsx?)$/i;
const SESSION = /^[0-9a-f-]{36}$/i;
const prefix = (sessionId: string) => `fornecedores-pagar/_pending/${sessionId}`;
const metaKey = (sessionId: string) => `${prefix(sessionId)}/metadata.json`;
const partKey = (sessionId: string, part: number) => `${prefix(sessionId)}/parts/${String(part).padStart(4, "0")}`;

function metadataError(meta: Staged) {
  if (!meta.entryId) return "PEDIDO INVÁLIDO.";
  if (!validAttachmentName(meta.fileName)) return "SELECIONE UM ARQUIVO VÁLIDO.";
  if (!EXTENSIONS.test(meta.fileName)) return "ANEXE PDF, JPG, PNG, CSV, XLS OU XLSX.";
  if (!Number.isInteger(meta.fileSize) || meta.fileSize <= 0) return "O ARQUIVO ESTÁ VAZIO OU É INVÁLIDO.";
  if (meta.fileSize > MAX_PDF_SIZE) return "O ARQUIVO DEVE TER NO MÁXIMO 25 MB.";
  return "";
}

async function entryExists(id: string) {
  const database = await getD1();
  return Boolean(await database.prepare("SELECT id FROM ap_simple_entries WHERE id=?1 AND deleted=0").bind(id).first());
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

async function create(payload: Record<string, unknown>) {
  const meta: Staged = {
    entryId: safeText(payload.entryId, 80),
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: Number(payload.fileSize),
    numberOfParts: Number(payload.numberOfParts),
  };
  const error = metadataError(meta);
  if (error) return jsonResponse({ error }, 400);
  if (!(await entryExists(meta.entryId))) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
  const expected = Math.ceil(meta.fileSize / PDF_CHUNK_SIZE);
  if (meta.numberOfParts !== expected) return jsonResponse({ error: "A DIVISÃO DO ARQUIVO É INVÁLIDA. SELECIONE-O NOVAMENTE." }, 400);
  const sessionId = crypto.randomUUID();
  const bucket = await documentsBucket();
  await bucket.put(metaKey(sessionId), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
  return jsonResponse({ session: { id: sessionId, numberOfParts: expected } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = safeText(request.headers.get("x-fpg-upload-id"), 80);
  const part = Number(request.headers.get("x-fpg-part-number"));
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
    if (!(await entryExists(meta.entryId))) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
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
    const r2Key = `fornecedores-pagar/${meta.entryId}/${id}-${safeR2FileName(meta.fileName)}`;
    const contentType = meta.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE;
    await bucket.put(r2Key, new Uint8Array(await new Blob(parts).arrayBuffer()), { httpMetadata: { contentType } });
    try {
      const database = await getD1();
      await database
        .prepare(`INSERT INTO ap_simple_attachments (id, entry_id, file_name, r2_key, size_bytes, content_type, uploaded_by_name, uploaded_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
        .bind(id, meta.entryId, meta.fileName, r2Key, meta.fileSize, contentType, actorName(actor), new Date().toISOString())
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

function fileError(message: string, status: number) {
  return new Response(message, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

async function openFile(request: Request, head: boolean) {
  const checked = guard(request, "view");
  if ("error" in checked) return checked.error;
  const url = new URL(request.url);
  try {
    const database = await getD1();
    const row = await database
      .prepare("SELECT file_name AS fileName, r2_key AS r2Key FROM ap_simple_attachments WHERE id=?1 AND deleted=0")
      .bind(safeText(url.searchParams.get("id"), 80))
      .first<{ fileName: string; r2Key: string }>();
    if (!row) return fileError("ANEXO NÃO ENCONTRADO.", 404);
    const bucket = await documentsBucket();
    const object = head ? await bucket.head(row.r2Key) : await bucket.get(row.r2Key);
    if (!object) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);
    return new Response(head ? null : (object as R2ObjectBody).body, {
      headers: {
        "content-type": object.httpMetadata?.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
        "content-disposition": contentDisposition(row.fileName, url.searchParams.get("download") === "1"),
        "content-length": String(object.size),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  } catch (error) {
    console.error("Não foi possível abrir o anexo do pedido.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ANEXO.", 500);
  }
}

export const GET = (request: Request) => openFile(request, false);
export const HEAD = (request: Request) => openFile(request, true);

export async function POST(request: Request) {
  const checked = guard(request, "create");
  if ("error" in checked) return checked.error;
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/octet-stream")) return await storeChunk(request);
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = safeText(payload.action, 20);
    if (action === "create") return await create(payload);
    if (action === "complete") return await complete(payload, checked.actor);
    if (action === "cancel") {
      const sessionId = safeText(payload.sessionId, 80);
      if (SESSION.test(sessionId)) await removeStaged(await documentsBucket(), sessionId);
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível anexar o arquivo no pedido.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O ARQUIVO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request, "create");
  if ("error" in checked) return checked.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const database = await getD1();
  const row = await database
    .prepare("UPDATE ap_simple_attachments SET deleted=1, deleted_by_name=?2 WHERE id=?1 AND deleted=0 RETURNING id")
    .bind(safeText(body.attachmentId, 80), actorName(checked.actor))
    .first<{ id: string }>();
  if (!row) return jsonResponse({ error: "ANEXO NÃO ENCONTRADO." }, 404);
  return jsonResponse({ deleted: true });
}
