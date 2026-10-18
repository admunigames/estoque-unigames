import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, contentDisposition, documentsBucket } from "../../documents/shared";
import { canView, findInventory, identity, safeText } from "../shared";

// Abre/baixa uma recontagem anexada ao inventário (?id=<anexo>), no escopo de loja.
function fileError(message: string, status: number) {
  return new Response(message, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

async function inventoryFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor)) return fileError("VOCÊ NÃO TEM ACESSO AO INVENTÁRIO.", 403);
  const url = new URL(request.url);
  const id = safeText(url.searchParams.get("id"), 80);
  try {
    const database = await getD1();
    const row = await database
      .prepare("SELECT inventory_id AS inventoryId, file_name AS fileName, r2_key AS r2Key FROM inventory_attachments WHERE id=?1 AND deleted=0")
      .bind(id)
      .first<{ inventoryId: string; fileName: string; r2Key: string }>();
    if (!row || !(await findInventory(database, actor, row.inventoryId))) return fileError("ANEXO NÃO ENCONTRADO.", 404);
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
    console.error("Não foi possível abrir o anexo do inventário.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O ANEXO.", 500);
  }
}

export const GET = (request: Request) => inventoryFile(request);
export const HEAD = (request: Request) => inventoryFile(request, true);
