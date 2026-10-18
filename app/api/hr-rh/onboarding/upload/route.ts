import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { documentsBucket, safeR2FileName, validAttachmentName } from "../../../documents/shared";
import { actorName, identity, jsonResponse, rhCan, safeText, sameOrigin, type JsonMap } from "../../shared";

// Envio do arquivo de um vídeo de Onboarding para o R2 em partes (multipart
// nativo do R2: cada parte vai direto para o armazenamento, sem juntar o
// vídeo na memória do Worker). create → partes em /upload-part → complete.

const VIDEO_PART_SIZE = 8 * 1024 * 1024;
const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024;
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);

function videoKeyPrefix(videoId: string) {
  return `hr-onboarding/${videoId}/`;
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!rhCan(actor, "rh_onboarding:videos")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ENVIAR VÍDEOS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    const videoId = safeText(body.videoId, 80);
    const database = await getD1();
    const video = await database
      .prepare("SELECT id, r2_key AS r2Key FROM hr_onboarding_videos WHERE id=?1")
      .bind(videoId)
      .first<{ id: string; r2Key: string }>();
    if (!video) return jsonResponse({ error: "VÍDEO NÃO ENCONTRADO." }, 404);
    const bucket = await documentsBucket();

    if (action === "create") {
      const fileName = safeText(body.fileName, 181);
      const contentType = safeText(body.contentType, 80).toLowerCase();
      const fileSize = Number(body.fileSize);
      if (!validAttachmentName(fileName)) return jsonResponse({ error: "SELECIONE UM ARQUIVO VÁLIDO." }, 400);
      if (!VIDEO_TYPES.has(contentType)) return jsonResponse({ error: "ENVIE UM VÍDEO MP4, WEBM OU MOV." }, 400);
      if (!Number.isInteger(fileSize) || fileSize <= 0 || fileSize > MAX_VIDEO_SIZE) {
        return jsonResponse({ error: "O VÍDEO DEVE TER NO MÁXIMO 2 GB." }, 400);
      }
      const key = `${videoKeyPrefix(videoId)}${crypto.randomUUID()}-${safeR2FileName(fileName)}`;
      const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
      return jsonResponse({ key, uploadId: upload.uploadId, partSize: VIDEO_PART_SIZE }, 201);
    }

    const key = safeText(body.key, 400);
    const uploadId = safeText(body.uploadId, 400);
    if (!key.startsWith(videoKeyPrefix(videoId)) || !uploadId) {
      return jsonResponse({ error: "ENVIO INVÁLIDO. SELECIONE O VÍDEO NOVAMENTE." }, 400);
    }
    const upload = bucket.resumeMultipartUpload(key, uploadId);

    if (action === "abort") {
      await upload.abort().catch(() => undefined);
      return jsonResponse({ aborted: true });
    }

    if (action === "complete") {
      const parts = (Array.isArray(body.parts) ? body.parts : [])
        .map((part) => part as JsonMap)
        .map((part) => ({ partNumber: Number(part.partNumber), etag: safeText(part.etag, 200) }))
        .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag);
      if (!parts.length) return jsonResponse({ error: "O ENVIO DO VÍDEO FICOU INCOMPLETO." }, 400);
      const object = await upload.complete(parts);
      const durationSeconds = Math.max(0, Math.round(Number(body.durationSeconds) || 0));
      if (!durationSeconds) {
        await bucket.delete(key).catch(() => undefined);
        return jsonResponse({ error: "NÃO FOI POSSÍVEL LER A DURAÇÃO DO VÍDEO. CONFIRA O ARQUIVO." }, 400);
      }
      await database
        .prepare(
          `UPDATE hr_onboarding_videos SET file_name=?1, r2_key=?2, content_type=?3, size_bytes=?4, duration_seconds=?5,
             updated_by=?6, updated_by_name=?7, updated_at=?8 WHERE id=?9`,
        )
        .bind(
          safeText(body.fileName, 181), key, object.httpMetadata?.contentType || "video/mp4", object.size,
          durationSeconds, actor.id, actorName(actor), new Date().toISOString(), videoId,
        )
        .run();
      if (video.r2Key && video.r2Key !== key) await bucket.delete(video.r2Key).catch(() => undefined);
      return jsonResponse({ uploaded: true, id: videoId });
    }

    return jsonResponse({ error: "AÇÃO DE ENVIO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível enviar o vídeo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENVIAR O VÍDEO." }, 500);
  }
}
