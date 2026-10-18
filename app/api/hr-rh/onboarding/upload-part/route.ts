import { unauthorizedResponse } from "../../../../lib/notion";
import { documentsBucket } from "../../../documents/shared";
import { identity, jsonResponse, rhCan, safeText, sameOrigin } from "../../shared";

// Uma parte (até 8 MB) do vídeo em envio — ver ../upload/route.ts. Fora da
// Auditoria (app/lib/audit.ts): o registro fica no "complete".

const VIDEO_PART_SIZE = 8 * 1024 * 1024;

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!rhCan(identity(request), "rh_onboarding:videos")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ENVIAR VÍDEOS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const key = safeText(request.headers.get("x-upload-key"), 400);
  const uploadId = safeText(request.headers.get("x-upload-id"), 400);
  const partNumber = Number(request.headers.get("x-part-number"));
  if (!key.startsWith("hr-onboarding/") || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return jsonResponse({ error: "UMA PARTE DO VÍDEO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
  }
  try {
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > VIDEO_PART_SIZE) {
      return jsonResponse({ error: "UMA PARTE DO VÍDEO É INVÁLIDA. TENTE NOVAMENTE." }, 400);
    }
    const bucket = await documentsBucket();
    const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, bytes);
    return jsonResponse({ partNumber: part.partNumber, etag: part.etag });
  } catch (error) {
    console.error("Não foi possível enviar uma parte do vídeo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENVIAR UMA PARTE DO VÍDEO. TENTE NOVAMENTE." }, 500);
  }
}
