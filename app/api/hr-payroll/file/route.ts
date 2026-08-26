import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { contentDisposition, documentsBucket } from "../../documents/shared";
import { canManagePayroll, identity, safeText } from "../shared";

// Abre/baixa o comprovante anexado a um lançamento da folha. Mesmo formato
// da rota de arquivo das Notas de O.S. (resposta binária com
// content-security-policy: sandbox), mas o acesso é gateado só por
// payroll:manage — folha é dado sensível e não tem visão por loja.

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

async function payrollFile(request: Request, head = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return fileError("VOCÊ NÃO TEM ACESSO AOS COMPROVANTES DA FOLHA.", 403);
  }

  const url = new URL(request.url);
  const id = safeText(url.searchParams.get("id"), 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fileError("LANÇAMENTO DE FOLHA INVÁLIDO.", 400);

  try {
    const database = await getD1();
    const row = await database
      .prepare(
        `SELECT attachment_file_name AS attachmentFileName, attachment_r2_key AS attachmentR2Key
         FROM hr_payroll_entries WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<FileRow>();
    if (!row) return fileError("LANÇAMENTO DE FOLHA NÃO ENCONTRADO.", 404);
    if (!row.attachmentR2Key) return fileError("ESTE LANÇAMENTO NÃO TEM COMPROVANTE ANEXADO.", 404);

    const bucket = await documentsBucket();
    const object = head
      ? await bucket.head(row.attachmentR2Key)
      : await bucket.get(row.attachmentR2Key);
    if (!object) return fileError("ARQUIVO PDF NÃO ENCONTRADO.", 404);

    const headers = new Headers({
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(
        row.attachmentFileName || "comprovante.pdf",
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
    console.error("Não foi possível abrir o comprovante da folha.", error);
    return fileError("NÃO FOI POSSÍVEL ABRIR O COMPROVANTE.", 500);
  }
}

export async function GET(request: Request) {
  return payrollFile(request);
}

export async function HEAD(request: Request) {
  return payrollFile(request, true);
}
