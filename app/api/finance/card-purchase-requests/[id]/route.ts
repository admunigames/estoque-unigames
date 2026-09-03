import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import {
  canApproveCardPurchases,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../shared";

// Aprovação/recusa de uma compra em cartão cadastrada pela Assistência
// (itens 9 e 10). Ao aprovar, a compra é copiada para
// finance_card_invoice_entries — a MESMA estrutura da fatura importada, nada
// de tabela paralela — dentro de um import 'manual' do mês da compra.

type RequestRow = {
  id: string;
  cardId: string;
  companyId: string;
  purchaseDate: string;
  merchant: string;
  amountCents: number;
  installmentLabel: string;
  installmentCurrent: number;
  installmentTotal: number;
  holderName: string;
  notes: string;
  status: string;
  invoiceEntryId: string;
};

const REQUEST_COLUMNS = `id, card_id AS cardId, company_id AS companyId, purchase_date AS purchaseDate,
  merchant, amount_cents AS amountCents, installment_label AS installmentLabel,
  installment_current AS installmentCurrent, installment_total AS installmentTotal,
  holder_name AS holderName, notes, status, invoice_entry_id AS invoiceEntryId`;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canApproveCardPurchases(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA APROVAR COMPRAS EM CARTÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "cards:approve");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const { id } = await context.params;

  try {
    const database = await getD1();
    const req = await database
      .prepare(`SELECT ${REQUEST_COLUMNS} FROM finance_card_purchase_requests WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<RequestRow>();
    if (!req) return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    if (!allStores && req.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA SOLICITAÇÃO." }, 403);
    }
    if (req.status !== "pending") {
      return jsonResponse({ error: "ESSA SOLICITAÇÃO JÁ FOI DECIDIDA." }, 409);
    }

    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 12);
    const note = safeText(body.note, 300);
    const who = actor.displayName || "Administrador";

    if (action === "reject") {
      await database
        .prepare(
          `UPDATE finance_card_purchase_requests
           SET status='rejected', decision_note=?1, decided_by=?2, decided_by_name=?3,
               decided_at=now()::text
           WHERE id=?4`,
        )
        .bind(note, actor.id, who, id)
        .run();
      return jsonResponse({ updated: true, id, status: "rejected" });
    }

    if (action !== "approve") {
      return jsonResponse({ error: "AÇÃO INVÁLIDA (approve OU reject)." }, 400);
    }

    // Aprovar: a compra vira um lançamento na fatura do cartão. Reaproveita
    // finance_card_invoice_entries; agrupa por um import 'manual' do mês.
    const referenceMonth = req.purchaseDate.slice(0, 7);
    let importRow = await database
      .prepare(
        `SELECT id FROM finance_card_invoice_imports
         WHERE card_id=?1 AND reference_month=?2 AND source_format='manual' LIMIT 1`,
      )
      .bind(req.cardId, referenceMonth)
      .first<{ id: string }>();
    if (!importRow) {
      const importId = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO finance_card_invoice_imports
            (id, card_id, reference_month, source_name, source_format, file_hash, row_count,
             created_by, created_by_name)
           VALUES (?1, ?2, ?3, 'Compras da Assistência', 'manual', '', 0, ?4, ?5)`,
        )
        .bind(importId, req.cardId, referenceMonth, actor.id, who)
        .run();
      importRow = { id: importId };
    }

    const entryId = crypto.randomUUID();
    await database.batch([
      database
        .prepare(
          `INSERT INTO finance_card_invoice_entries
            (id, import_id, card_id, company_id, entry_date, merchant, amount_cents,
             installment_label, installment_current, installment_total, holder_name, notes,
             status, purchase_request_id, created_by, created_by_name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', ?13, ?14, ?15)`,
        )
        .bind(
          entryId,
          importRow.id,
          req.cardId,
          req.companyId,
          req.purchaseDate,
          req.merchant,
          req.amountCents,
          req.installmentLabel,
          req.installmentCurrent,
          req.installmentTotal,
          req.holderName,
          req.notes,
          req.id,
          actor.id,
          who,
        ),
      database
        .prepare(
          `UPDATE finance_card_invoice_imports SET row_count = row_count + 1 WHERE id=?1`,
        )
        .bind(importRow.id),
      database
        .prepare(
          `UPDATE finance_card_purchase_requests
           SET status='approved', invoice_entry_id=?1, decision_note=?2, decided_by=?3,
               decided_by_name=?4, decided_at=now()::text
           WHERE id=?5`,
        )
        .bind(entryId, note, actor.id, who, id),
    ]);

    return jsonResponse({ updated: true, id, status: "approved", invoiceEntryId: entryId });
  } catch (error) {
    console.error("Não foi possível decidir a compra em cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL DECIDIR A COMPRA EM CARTÃO." }, 500);
  }
}
