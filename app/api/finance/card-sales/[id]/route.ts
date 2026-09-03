import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { computeCardReconStatus } from "../../../../lib/card-fees";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../shared";

// Revisão manual da conciliação de vendas de cartão (item 6). Quando uma
// venda cai em "Em Atenção", o Financeiro confere e marca como revisada
// (opcionalmente com uma nota). Reabrir volta o status ao que o cruzamento
// automático calcularia.

type SaleRow = {
  id: string;
  companyId: string;
  grossCents: number;
  expectedFeeCents: number;
  feeMissing: number;
  receivedAmountCents: number | null;
};

const SALE_COLUMNS = `id, company_id AS companyId, gross_cents AS grossCents,
  expected_fee_cents AS expectedFeeCents, fee_missing AS feeMissing,
  received_amount_cents AS receivedAmountCents`;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const { id } = await context.params;

  try {
    const database = await getD1();
    const sale = await database
      .prepare(`SELECT ${SALE_COLUMNS} FROM finance_card_sales WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<SaleRow>();
    if (!sale) return jsonResponse({ error: "VENDA NÃO ENCONTRADA." }, 404);
    if (!allStores && sale.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA VENDA." }, 403);
    }

    const body = (await request.json()) as JsonMap;
    const reviewed = body.reviewed !== false;
    const note = safeText(body.note, 300);

    if (reviewed) {
      await database
        .prepare(
          `UPDATE finance_card_sales
           SET recon_status='reviewed', reviewed_at=now()::text, reviewed_by=?1, reviewed_by_name=?2,
               reviewed_note=?3
           WHERE id=?4`,
        )
        .bind(actor.id, actor.displayName || "Administrador", note, id)
        .run();
      return jsonResponse({ updated: true, id, reconStatus: "reviewed" });
    }

    // Reabrir: recalcula o status pelo cruzamento automático.
    const reconStatus = computeCardReconStatus({
      feeMissing: Boolean(sale.feeMissing),
      grossCents: sale.grossCents,
      expectedFeeCents: sale.expectedFeeCents,
      receivedCents: sale.receivedAmountCents,
    });
    await database
      .prepare(
        `UPDATE finance_card_sales
         SET recon_status=?1, reviewed_at='', reviewed_by='', reviewed_by_name='', reviewed_note=''
         WHERE id=?2`,
      )
      .bind(reconStatus, id)
      .run();
    return jsonResponse({ updated: true, id, reconStatus });
  } catch (error) {
    console.error("Não foi possível atualizar a conciliação da venda.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A CONCILIAÇÃO DA VENDA." }, 500);
  }
}
