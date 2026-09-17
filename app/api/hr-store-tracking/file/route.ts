import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, contentDisposition, documentsBucket } from "../../documents/shared";
import { canViewStoreTracking, identity, safeText } from "../shared";

// Abre/baixa a ata de presença anexada a um registro de PDI de líder ou de
// acompanhamento por loja. Mesmo formato de app/api/hr-payroll/file/route.ts
// (resposta binária com content-security-policy: sandbox), mas liberado por
// rh_acompanhamento:view (leitura), não só :manage.

const TABLES: Record<string, string> = {
  leader: "hr_leader_pdi",
  store: "hr_store_tracking",
};

type FileRow = {
  attachmentFileName: string;
  attachmentR2Key: string;
};

function fileError(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function storeTrackingFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewStoreTracking(actor)) {
    return fileError("VOCÊ NÃO TEM ACESSO A ESTA ATA.", 403);
  }

  const url = new URL(request.url);
  const kind = safeText(url.searchParams.get("kind"), 20);
  const id = safeText(url.searchParams.get("id"), 80);
  const table = TABLES[kind];
  if (!table || !/^[0-9a-f-]{36}$/i.test(id)) return fileError("REGISTRO INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT attachment_file_name AS attachmentFileName, attachment_r2_key AS attachmentR2Key
         FROM ${table} WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("REGISTRO NÃO ENCONTRADO.", 404);
    if (!row.attachmentR2Key) return fileError("ESTE REGISTRO NÃO TEM ATA ANEXADA.", 404);

    const bucket = await documentsBucket();
    const object = head
      ? await bucket.head(row.attachmentR2Key)
      : await bucket.get(row.attachmentR2Key);
    if (!object) return fileError("ARQUIVO NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": object.httpMetadata?.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
      "content-disposition": contentDisposition(
        row.attachmentFileName || "ata",
        url.searchParams.get("download") === "1",
      ),
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag: object.httpEtag,
    });
    const body = head ? null : (object as R2ObjectBody).body;
    return new Response(body, { headers });
  } catch (error) {
    console.error("Não foi possível abrir a ata de presença.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR A ATA.", 500);
  }
}

export async function GET(request: Request) {
  return storeTrackingFile(request);
}

export async function HEAD(request: Request) {
  return storeTrackingFile(request, true);
}
