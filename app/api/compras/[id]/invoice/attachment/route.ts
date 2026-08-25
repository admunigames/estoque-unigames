import { getD1 } from "../../../../../../db";
import { canPurchases, unauthorizedResponse } from "../../../../../lib/notion";
import { handleInvoiceAttachmentUpload } from "../../../../finance/invoices/[id]/attachments/route";

type JsonMap = Record<string, unknown>;

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identity(request: Request) {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
  };
}

function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim() || "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

// Anexar o PDF da própria NF pela tela de Compras (permissão purchases:edit,
// mesma já usada pra editar o pedido) — reaproveita o mesmo motor de upload
// staged/multipart de app/api/finance/invoices/[id]/attachments/route.ts
// (mesmo bucket, mesma tabela, mesma validação de PDF), só com a checagem
// de permissão do lado de Compras em vez de Financeiro. O tipo de anexo é
// sempre 'nf' aqui — boleto/comprovante só são anexados pelo Financeiro.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canPurchases(request, "purchases:edit")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ANEXAR ARQUIVOS A ESTE PEDIDO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const { id } = await context.params;
  const notionPurchaseId = id.trim();

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supplier_invoices WHERE notion_purchase_id=?1 ORDER BY created_at DESC LIMIT 1")
      .bind(notionPurchaseId)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "CADASTRE A NOTA FISCAL ANTES DE ANEXAR O ARQUIVO." }, 404);

    const actor = identity(request);
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = (await request.clone().json().catch(() => ({}))) as JsonMap;
      if (body.action === "create" && safeText(body.attachmentType, 20) !== "nf") {
        return jsonResponse({ error: "PELA TELA DE COMPRAS SÓ É POSSÍVEL ANEXAR O ARQUIVO DA NOTA FISCAL." }, 400);
      }
    }
    return handleInvoiceAttachmentUpload(request, existing.id, actor);
  } catch (error) {
    console.error("Não foi possível anexar o arquivo da nota fiscal do pedido.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ANEXAR O ARQUIVO." }, 500);
  }
}
