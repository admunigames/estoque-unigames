import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { hasCompany } from "../../../../../../lib/access-scope";
import {
  MAX_PDF_SIZE,
  PDF_CHUNK_SIZE,
  documentsBucket,
  safeR2FileName,
  validAttachmentName,
} from "../../../../../documents/shared";
import {
  can,
  canSeeRequest,
  eventStatement,
  identity,
  inScope,
  jsonResponse,
  loadAttachments,
  loadItem,
  loadRequest,
  routeParam,
  safeText,
  sameOrigin,
  type Identity,
  type JsonMap,
  type RequestRow,
} from "../../../../shared";

// Anexos (imagem JPG/PNG/WEBP ou PDF) de um item da divergência. Mesmo
// protocolo em partes de 512 KB do Compras/RMA (create → partes → complete,
// ou cancel); o arquivo final vai para divergences/<pedido>/<item>/<id>-<nome>.
//   side 'adm':  quem responde (divergencias:respond, no escopo da loja).
//   side 'loja': login da PRÓPRIA loja do pedido com VISUALIZAR (sem exceção
//                por setor — app/lib/access-scope.ts).
// Excluir: quem enviou, ou o ADM (qualquer anexo). Envio e exclusão entram no
// histórico do item; a Auditoria (Worker) registra as chamadas.
//   GET                → lista os anexos do item
//   POST {action:"create", side, fileName, contentType, fileSize, numberOfParts}
//   POST (octet-stream, x-divergence-upload-id, x-divergence-part-number)
//   POST {action:"complete", sessionId} / {action:"cancel", sessionId}
//   DELETE ?attachmentId=

type Context = { params: Promise<{ id: string; itemId: string }> };
type Side = "adm" | "loja";
type Staged = {
  requestId: string;
  itemId: string;
  side: Side;
  fileName: string;
  contentType: string;
  fileSize: number;
  numberOfParts: number;
};

const ACCEPTED_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const SESSION = /^[0-9a-f-]{36}$/i;
const prefix = (sessionId: string) => `divergences/_pending/${sessionId}`;
const metaKey = (sessionId: string) => `${prefix(sessionId)}/metadata.json`;
const partKey = (sessionId: string, part: number) => `${prefix(sessionId)}/parts/${String(part).padStart(4, "0")}`;
const NOT_FOUND = "ITEM NÃO ENCONTRADO.";

function isAdm(actor: Identity, row: RequestRow) {
  return can(actor, "divergencias:respond") && inScope(actor, "divergencias:respond", row.companyId);
}

function isOwnStore(actor: Identity, row: RequestRow) {
  return can(actor, "divergencias:view") && hasCompany(actor.companyId) && actor.companyId === row.companyId;
}

function metadataError(meta: Staged) {
  if (meta.side !== "adm" && meta.side !== "loja") return "LADO DO ANEXO INVÁLIDO.";
  if (!validAttachmentName(meta.fileName)) return "SELECIONE UM ARQUIVO VÁLIDO.";
  if (!ACCEPTED_CONTENT_TYPES.has(meta.contentType)) return "ANEXE UMA IMAGEM (JPG, PNG, WEBP) OU PDF.";
  if (!Number.isInteger(meta.fileSize) || meta.fileSize <= 0) return "O ARQUIVO ESTÁ VAZIO OU É INVÁLIDO.";
  if (meta.fileSize > MAX_PDF_SIZE) return "O ARQUIVO DEVE TER NO MÁXIMO 25 MB.";
  return "";
}

/** Pedido + item, se o ator pode anexar deste lado; senão a resposta de erro. */
async function writableItem(database: D1Database, actor: Identity, requestId: string, itemId: string, side: Side) {
  const row = await loadRequest(database, requestId);
  const item = row ? await loadItem(database, requestId, itemId) : null;
  // Outra loja recebe o mesmo 404 de "não encontrado" (não revela que existe).
  if (!row || !item || !canSeeRequest(actor, row.companyId)) return { error: jsonResponse({ error: NOT_FOUND }, 404) };
  const allowed = side === "adm" ? isAdm(actor, row) : isOwnStore(actor, row);
  if (!allowed) {
    return {
      error: jsonResponse({
        error: side === "adm" ? "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR NA RESPOSTA." : "SÓ A LOJA DO PEDIDO ANEXA NO RETORNO DA LOJA.",
      }, 403),
    };
  }
  return { row, item };
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

async function create(payload: JsonMap, actor: Identity, requestId: string, itemId: string) {
  const meta: Staged = {
    requestId,
    itemId,
    side: safeText(payload.side, 10) as Side,
    fileName: safeText(payload.fileName, 181),
    contentType: safeText(payload.contentType, 80).toLowerCase(),
    fileSize: Number(payload.fileSize),
    numberOfParts: Number(payload.numberOfParts),
  };
  const error = metadataError(meta);
  if (error) return jsonResponse({ error }, 400);
  const checked = await writableItem(await getD1(), actor, requestId, itemId, meta.side);
  if (checked.error) return checked.error;
  const expected = Math.ceil(meta.fileSize / PDF_CHUNK_SIZE);
  if (meta.numberOfParts !== expected) return jsonResponse({ error: "A DIVISÃO DO ARQUIVO É INVÁLIDA. SELECIONE-O NOVAMENTE." }, 400);
  const sessionId = crypto.randomUUID();
  const bucket = await documentsBucket();
  await bucket.put(metaKey(sessionId), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
  return jsonResponse({ session: { id: sessionId, numberOfParts: expected } }, 201);
}

async function storeChunk(request: Request) {
  const sessionId = safeText(request.headers.get("x-divergence-upload-id"), 80);
  const part = Number(request.headers.get("x-divergence-part-number"));
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

async function complete(payload: JsonMap, actor: Identity, requestId: string, itemId: string) {
  const sessionId = safeText(payload.sessionId, 80);
  if (!SESSION.test(sessionId)) return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 400);
  const bucket = await documentsBucket();
  try {
    const meta = await readMeta(bucket, sessionId);
    if (!meta) return jsonResponse({ error: "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE." }, 410);
    if (meta.requestId !== requestId || meta.itemId !== itemId) return jsonResponse({ error: NOT_FOUND }, 404);
    const error = metadataError(meta);
    if (error) return jsonResponse({ error }, 400);
    const database = await getD1();
    const checked = await writableItem(database, actor, requestId, itemId, meta.side);
    if (checked.error) return checked.error;
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
    const r2Key = `divergences/${requestId}/${itemId}/${id}-${safeR2FileName(meta.fileName)}`;
    const at = new Date().toISOString();
    await bucket.put(r2Key, new Uint8Array(await new Blob(parts).arrayBuffer()), {
      httpMetadata: { contentType: meta.contentType },
    });
    try {
      await database.batch([
        database
          .prepare(
            `INSERT INTO divergence_item_attachments
              (id, item_id, request_id, side, r2_key, file_name, content_type, size, uploaded_by, uploaded_by_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
          )
          .bind(id, itemId, requestId, meta.side, r2Key, meta.fileName, meta.contentType, meta.fileSize,
            actor.id, actor.displayName, at),
        eventStatement(database, {
          itemId, requestId, kind: "attachment", fromStatus: checked.item.status, toStatus: checked.item.status,
          text: `${meta.side === "adm" ? "ADM" : "LOJA"}: ${meta.fileName}`, actor, at,
        }),
      ]);
    } catch (insertError) {
      await bucket.delete(r2Key).catch(() => undefined);
      throw insertError;
    }
    return jsonResponse({ attached: true, id, name: meta.fileName }, 201);
  } finally {
    await removeStaged(bucket, sessionId).catch(() => undefined);
  }
}

export async function GET(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  try {
    const params = await context.params;
    const requestId = routeParam(params.id);
    const itemId = routeParam(params.itemId);
    const database = await getD1();
    const row = await loadRequest(database, requestId);
    if (!row || !canSeeRequest(actor, row.companyId)) return jsonResponse({ error: NOT_FOUND }, 404);
    const attachments = (await loadAttachments(database, requestId)).filter((attachment) => attachment.itemId === itemId);
    return jsonResponse({ attachments });
  } catch (error) {
    console.error("Não foi possível listar os anexos da divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS ANEXOS." }, 500);
  }
}

export async function POST(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const actor = identity(request);
  try {
    const params = await context.params;
    const requestId = routeParam(params.id);
    const itemId = routeParam(params.itemId);
    const contentType = request.headers.get("content-type") || "";
    // As partes valem só para uma sessão criada com permissão checada.
    if (contentType.includes("application/octet-stream")) return await storeChunk(request);
    if (!contentType.includes("application/json")) return jsonResponse({ error: "TIPO DE REQUISIÇÃO INVÁLIDO." }, 400);
    const payload = (await request.json()) as JsonMap;
    const action = safeText(payload.action, 20);
    if (action === "create") return await create(payload, actor, requestId, itemId);
    if (action === "complete") return await complete(payload, actor, requestId, itemId);
    if (action === "cancel") {
      const sessionId = safeText(payload.sessionId, 80);
      if (SESSION.test(sessionId)) await removeStaged(await documentsBucket(), sessionId);
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível anexar o arquivo na divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O ARQUIVO." }, 500);
  }
}

// Exclusão definitiva: apaga o arquivo no R2 e o registro (R2 antes do banco,
// como no Compras). O nome vai na resposta para a Auditoria.
export async function DELETE(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const actor = identity(request);
  try {
    const params = await context.params;
    const requestId = routeParam(params.id);
    const itemId = routeParam(params.itemId);
    const attachmentId = safeText(new URL(request.url).searchParams.get("attachmentId"), 80);
    if (!attachmentId) return jsonResponse({ error: "ANEXO INVÁLIDO." }, 400);
    const database = await getD1();
    const row = await loadRequest(database, requestId);
    const attachment = row
      ? await database
        .prepare(
          `SELECT r2_key AS r2Key, file_name AS fileName, side, uploaded_by AS uploadedBy
           FROM divergence_item_attachments WHERE id=?1 AND item_id=?2 AND request_id=?3`,
        )
        .bind(attachmentId, itemId, requestId)
        .first<{ r2Key: string; fileName: string; side: string; uploadedBy: string }>()
      : null;
    if (!row || !attachment || !canSeeRequest(actor, row.companyId)) {
      return jsonResponse({ error: "ANEXO NÃO ENCONTRADO." }, 404);
    }
    if (attachment.uploadedBy !== actor.id && !isAdm(actor, row)) {
      return jsonResponse({ error: "SÓ QUEM ENVIOU (OU O ADM) EXCLUI ESTE ANEXO." }, 403);
    }
    const item = await loadItem(database, requestId, itemId);
    await (await documentsBucket()).delete(attachment.r2Key);
    const at = new Date().toISOString();
    await database.batch([
      database.prepare("DELETE FROM divergence_item_attachments WHERE id=?1").bind(attachmentId),
      eventStatement(database, {
        itemId, requestId, kind: "attachment_delete", fromStatus: item?.status || "", toStatus: item?.status || "",
        text: `${attachment.side === "adm" ? "ADM" : "LOJA"}: ${attachment.fileName}`, actor, at,
      }),
    ]);
    return jsonResponse({ deleted: true, id: attachmentId, name: attachment.fileName });
  } catch (error) {
    console.error("Não foi possível excluir o anexo da divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ANEXO." }, 500);
  }
}
