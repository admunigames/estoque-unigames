import { getD1 } from "../../../../../db";
import { videoAppliesTo } from "../../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../../lib/notion";
import { documentsBucket } from "../../../documents/shared";
import { identity, rhCan, safeText } from "../../shared";
import { employeeOfUser } from "../shared";

// Vídeo do Onboarding com suporte a Range (o <video> do Safari/iPhone só toca
// com resposta 206). Quem vê: RH (vídeos/acompanhamento) ou o colaborador
// cuja trilha inclui o vídeo.

function fileError(message: string, status: number) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function serve(request: Request, head: boolean) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  try {
    const database = await getD1();
    const video = await database
      .prepare("SELECT r2_key AS r2Key, role_title AS roleTitle, company_id AS companyId, active FROM hr_onboarding_videos WHERE id=?1")
      .bind(id)
      .first<{ r2Key: string; roleTitle: string; companyId: string; active: number }>();
    if (!video || !video.r2Key) return fileError("VÍDEO NÃO ENCONTRADO.", 404);
    if (!rhCan(actor, "rh_onboarding:videos", "rh_onboarding:track")) {
      const employee = await employeeOfUser(database, actor.id);
      if (!employee || !videoAppliesTo(video, employee)) return fileError("VÍDEO NÃO ENCONTRADO.", 404);
    }
    const bucket = await documentsBucket();
    const object = await bucket.get(video.r2Key, { range: request.headers });
    if (!object) return fileError("VÍDEO NÃO ENCONTRADO.", 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
    if (range && request.headers.has("range")) {
      const offset = range.suffix !== undefined ? object.size - range.suffix : range.offset ?? 0;
      const length = range.suffix !== undefined ? range.suffix : range.length ?? object.size - offset;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("content-length", String(length));
      return new Response(head ? null : object.body, { status: 206, headers });
    }
    headers.set("content-length", String(object.size));
    return new Response(head ? null : object.body, { headers });
  } catch (error) {
    console.error("Não foi possível abrir o vídeo.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O VÍDEO.", 500);
  }
}

export async function GET(request: Request) {
  return serve(request, false);
}

export async function HEAD(request: Request) {
  return serve(request, true);
}
