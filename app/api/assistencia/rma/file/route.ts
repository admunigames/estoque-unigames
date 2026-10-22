import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, contentDisposition, documentsBucket, safeR2FileName } from "../../../documents/shared";
import { canView, identity, ownerRma, safeText } from "../shared";

// Abre/baixa um anexo do RMA (?id=<anexo>), no escopo de loja. Anexo importado
// do Base44 (r2_key '') é copiado para o R2 na primeira abertura — só da pasta
// pública do app RMA antigo (nenhum outro endereço é buscado).
const LEGACY_PREFIX = "https://base44.app/api/apps/6a0f1ab5fe3a52c5678c3c51/files/";

function fileError(message: string, status: number) {
  return new Response(message, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

type Row = { id: string; ownerType: string; ownerId: string; rmaId: string; fileName: string; r2Key: string; sourceUrl: string; contentType: string };

async function copyLegacy(database: Awaited<ReturnType<typeof getD1>>, bucket: R2Bucket, row: Row) {
  if (!row.sourceUrl.startsWith(LEGACY_PREFIX)) return null;
  const response = await fetch(row.sourceUrl, { redirect: "follow" });
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || row.contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE;
  const r2Key = `rma/${row.rmaId || row.ownerId}/${row.id}-${safeR2FileName(row.fileName)}`;
  await bucket.put(r2Key, bytes, { httpMetadata: { contentType } });
  await database
    .prepare("UPDATE rma_attachments SET r2_key=?1, size_bytes=?2, content_type=?3 WHERE id=?4")
    .bind(r2Key, bytes.byteLength, contentType, row.id)
    .run();
  return r2Key;
}

async function rmaFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor)) return fileError("VOCÊ NÃO TEM ACESSO AO RMA.", 403);
  const url = new URL(request.url);
  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT id, owner_type AS ownerType, owner_id AS ownerId, rma_id AS rmaId, file_name AS fileName, r2_key AS r2Key,
                source_url AS sourceUrl, content_type AS contentType
         FROM rma_attachments WHERE id=?1 AND deleted=0`,
      )
      .bind(safeText(url.searchParams.get("id"), 80))
      .first<Row>();
    if (!row || (await ownerRma(database, actor, row.ownerType, row.ownerId)) === null) return fileError("ANEXO NÃO ENCONTRADO.", 404);
    const bucket = await documentsBucket();
    const r2Key = row.r2Key || (await copyLegacy(database, bucket, row));
    const object = r2Key ? (head ? await bucket.head(r2Key) : await bucket.get(r2Key)) : null;
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
    console.error("Não foi possível abrir o anexo do RMA.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ANEXO.", 500);
  }
}

export const GET = (request: Request) => rmaFile(request);
export const HEAD = (request: Request) => rmaFile(request, true);
