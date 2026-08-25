import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { identity, jsonResponse, safeText, sameOrigin } from "../../../shared";
import {
  assertInvoiceAccess,
  canReturnInvoiceToPurchases,
  invoiceEventStatement,
  loadInvoice,
} from "../../shared";

// Devolver a NF para Compras corrigir — preserva a NF e as duplicatas já
// cadastradas (não cria um registro novo, não apaga nada); só marca
// pending_correction e volta o financial_status pra aguardando_conferencia,
// o que também reabre a possibilidade de reenvio da MESMA nota pela tela de
// Compras (ver app/api/compras/[id]/invoice/send/route.ts).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canReturnInvoiceToPurchases(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA DEVOLVER NOTAS FISCAIS PARA COMPRAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const invoice = await loadInvoice(database, id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    if (invoice.canceled) return jsonResponse({ error: "ESTA NOTA FISCAL ESTÁ CANCELADA." }, 409);
    if (invoice.origin !== "purchase") {
      return jsonResponse({ error: "NOTAS FISCAIS CADASTRADAS MANUALMENTE NÃO PODEM SER DEVOLVIDAS A COMPRAS." }, 409);
    }
    if (!invoice.sentToFinanceAt) {
      return jsonResponse({ error: "ESTA NOTA FISCAL AINDA NÃO FOI ENVIADA AO FINANCEIRO." }, 409);
    }
    if (invoice.financialStatus === "pago") {
      return jsonResponse({ error: "UMA NOTA FISCAL JÁ PAGA NÃO PODE SER DEVOLVIDA." }, 409);
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const body = (await request.json()) as Record<string, unknown>;
    const reason = safeText(body.reason, 1000);
    if (!reason) return jsonResponse({ error: "INFORME O MOTIVO DA DEVOLUÇÃO." }, 400);

    const actorName = actor.displayName || "Administrador";
    const statements = [
      [
        `UPDATE supplier_invoices
         SET financial_status='aguardando_conferencia', pending_correction=1, return_reason=?1,
             returned_by=?2, returned_by_name=?3, returned_at=CURRENT_TIMESTAMP::text,
             updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
        [reason, actor.id, actorName, id],
      ] as [string, unknown[]],
      invoiceEventStatement({
        invoiceId: id,
        eventType: "returned_to_purchases",
        description: `DEVOLVIDA PARA COMPRAS: ${reason}`,
        actorId: actor.id,
        actorName,
      }),
    ];

    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ returned: true });
  } catch (error) {
    console.error("Não foi possível devolver a nota fiscal para compras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL DEVOLVER A NOTA FISCAL PARA COMPRAS." }, 500);
  }
}
