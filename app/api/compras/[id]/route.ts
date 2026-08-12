import {
  apiErrorResponse,
  appendUploadedFiles,
  buildPurchaseProperties,
  canPurchases,
  normalizePurchase,
  notionRequest,
  parsePurchaseInput,
  unauthorizedResponse,
} from "../../../lib/notion";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canPurchases(request, "purchases:edit")) {
    return Response.json({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR COMPRAS." }, { status: 403 });
  }

  try {
    const { id } = await context.params;
    const pageId = id.trim();
    if (!pageId) {
      return Response.json({ error: "PEDIDO INVÁLIDO." }, { status: 400 });
    }

    const input = parsePurchaseInput(await request.json());
    const properties = buildPurchaseProperties(input);
    if (input.arquivos?.pedido?.length || input.arquivos?.notaFiscal?.length) {
      const currentPage = await notionRequest(`/pages/${encodeURIComponent(pageId)}`);
      appendUploadedFiles(currentPage, properties, input);
    }

    const result = await notionRequest(`/pages/${encodeURIComponent(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    return Response.json({ item: normalizePurchase(result) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

