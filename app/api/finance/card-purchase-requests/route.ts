import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  isCardPurchaseRequestStatus,
  normalizeInstallments,
  validateCardPurchaseDraft,
} from "../../../lib/card-purchase-requests";
import {
  canApproveCardPurchases,
  canRequestCardPurchases,
  identity,
  jsonResponse,
  loadCompanyList,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Compras em cartão cadastradas pela Assistência (itens 8-10).
// GET  — lista de solicitações (quem só cadastra vê as próprias; quem aprova
//        vê todas, respeitando o escopo por loja).
// POST — cadastra uma nova compra (cards:request); entra como 'pending'.

const REQUEST_COLUMNS = `id, card_id AS cardId, company_id AS companyId, company_name AS companyName,
  purchase_date AS purchaseDate, merchant, amount_cents AS amountCents,
  installment_label AS installmentLabel, installment_current AS installmentCurrent,
  installment_total AS installmentTotal, holder_name AS holderName, notes, status,
  invoice_entry_id AS invoiceEntryId, decision_note AS decisionNote,
  requested_by AS requestedBy, requested_by_name AS requestedByName, requested_at AS requestedAt,
  decided_by AS decidedBy, decided_by_name AS decidedByName, decided_at AS decidedAt`;

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canRequestCardPurchases(actor) && !canApproveCardPurchases(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR AS COMPRAS EM CARTÃO." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const isApprover = canApproveCardPurchases(actor);
  const allStores = canSeeAllStores(scopeActor, "cards:approve");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const params = new URL(request.url).searchParams;
  const status = safeText(params.get("status"), 12);
  const cardId = safeText(params.get("cardId"), 80);
  const requestedCompany = safeText(params.get("companyId"), 80);

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const values: unknown[] = [];

    const effectiveCompany = allStores ? requestedCompany : scopeActor.companyId;
    if (effectiveCompany) {
      values.push(effectiveCompany);
      conditions.push(`company_id=?${values.length}`);
    }
    // Quem só cadastra (não aprova) enxerga apenas as próprias solicitações.
    if (!isApprover) {
      values.push(actor.id);
      conditions.push(`requested_by=?${values.length}`);
    }
    if (isCardPurchaseRequestStatus(status)) {
      values.push(status);
      conditions.push(`status=?${values.length}`);
    }
    if (cardId) {
      values.push(cardId);
      conditions.push(`card_id=?${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await database
      .prepare(
        `SELECT ${REQUEST_COLUMNS} FROM finance_card_purchase_requests ${where}
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                  requested_at DESC
         LIMIT 500`,
      )
      .bind(...values)
      .all();

    const counts = await database
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,
                COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) AS approved,
                COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rejected
         FROM finance_card_purchase_requests ${where}`,
      )
      .bind(...values)
      .first<Record<string, number>>();

    // Cartões ativos que o solicitante pode escolher — versão enxuta (sem
    // limite/fatura), para não depender do endpoint de cartões que exige
    // finance:manage.
    const cardValues: unknown[] = [];
    let cardWhere = "status='active'";
    if (!allStores) {
      cardValues.push(scopeActor.companyId);
      cardWhere += ` AND company_id=?${cardValues.length}`;
    } else if (effectiveCompany) {
      cardValues.push(effectiveCompany);
      cardWhere += ` AND company_id=?${cardValues.length}`;
    }
    const cards = await database
      .prepare(
        `SELECT id, name, last4, kind, company_id AS companyId, company_name AS companyName
         FROM finance_corporate_cards WHERE ${cardWhere} ORDER BY kind, lower(name)`,
      )
      .bind(...cardValues)
      .all();

    return jsonResponse({
      requests: rows.results ?? [],
      counts: counts ?? {},
      canApprove: isApprover,
      availableCards: cards.results ?? [],
    });
  } catch (error) {
    console.error("Não foi possível carregar as compras em cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS COMPRAS EM CARTÃO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canRequestCardPurchases(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR COMPRAS EM CARTÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "cards:approve");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const cardId = safeText(body.cardId, 80);
    const purchaseDate = safeText(body.purchaseDate, 10);
    const merchant = safeText(body.merchant, 200);
    const amountCents = Math.round(Number(body.amountCents));
    const installments = normalizeInstallments(body.installmentCurrent, body.installmentTotal);
    const holderName = safeText(body.holderName, 120);
    const notes = safeText(body.notes, 1000);

    const draftError = validateCardPurchaseDraft({
      cardId,
      purchaseDate,
      merchant,
      amountCents,
      installmentTotal: installments.total,
    });
    if (draftError) return jsonResponse({ error: draftError }, 400);

    const database = await getD1();
    const card = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName, status
         FROM finance_corporate_cards WHERE id=?1`,
      )
      .bind(cardId)
      .first<{ id: string; companyId: string; companyName: string; status: string }>();
    if (!card) return jsonResponse({ error: "CARTÃO NÃO ENCONTRADO." }, 400);
    if (card.status !== "active") {
      return jsonResponse({ error: "ESSE CARTÃO NÃO ESTÁ ATIVO." }, 400);
    }
    if (!allStores && card.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSE CARTÃO." }, 403);
    }

    // company_name é re-resolvido do cadastro (snapshot só para exibição).
    const companies = await loadCompanyList(database);
    const companyName = companies.find((row) => row.id === card.companyId)?.name ?? card.companyName;

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_card_purchase_requests
          (id, card_id, company_id, company_name, purchase_date, merchant, amount_cents,
           installment_label, installment_current, installment_total, holder_name, notes,
           status, requested_by, requested_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', ?13, ?14)`,
      )
      .bind(
        id,
        cardId,
        card.companyId,
        companyName,
        purchaseDate,
        merchant,
        amountCents,
        installments.label,
        installments.current,
        installments.total,
        holderName,
        notes,
        actor.id,
        actor.displayName || "Assistência",
      )
      .run();

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a compra em cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A COMPRA EM CARTÃO." }, 500);
  }
}
