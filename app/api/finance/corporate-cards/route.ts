import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  hasForbiddenCardKey,
  isCorporateCardStatus,
  validateCorporateCardDraft,
} from "../../../lib/corporate-cards";
import { isCardKind } from "../../../lib/card-purchase-requests";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Cartões de Crédito Corporativos (Financeiro Fase 7).
// SEGURANÇA: nenhum campo de senha ou CVV. Se o corpo trouxer qualquer
// chave proibida, a requisição é recusada (400) antes de qualquer escrita.

type CardRow = {
  id: string;
  name: string;
  bank: string;
  brand: string;
  last4: string;
  limitCents: number;
  bestPurchaseDay: number;
  closingDay: number;
  dueDay: number;
  holderName: string;
  companyId: string;
  companyName: string;
  status: string;
  kind: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

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
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const database = await getD1();
    const values: unknown[] = [];
    let where = "";
    if (!allStores) {
      values.push(scopeActor.companyId);
      where = "WHERE company_id=?1";
    }
    const result = await database
      .prepare(
        `SELECT id, name, bank, brand, last4, limit_cents AS limitCents,
                best_purchase_day AS bestPurchaseDay, closing_day AS closingDay, due_day AS dueDay,
                holder_name AS holderName, company_id AS companyId, company_name AS companyName,
                status, kind, notes, created_at AS createdAt, updated_at AS updatedAt
         FROM finance_corporate_cards ${where}
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END ASC,
           lower(name) ASC`,
      )
      .bind(...values)
      .all<CardRow>();
    return jsonResponse({ cards: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os cartões corporativos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS CARTÕES CORPORATIVOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CARTÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    // SEGURANÇA: recusa qualquer tentativa de mandar senha/CVV.
    if (hasForbiddenCardKey(body)) {
      return jsonResponse(
        { error: "DADOS DE SENHA OU CVV NÃO SÃO ACEITOS E NÃO DEVEM SER INFORMADOS." },
        400,
      );
    }

    const editId = safeText(body.id, 80);
    const name = safeText(body.name, 120);
    const bank = safeText(body.bank, 80);
    const brand = safeText(body.brand, 40);
    const last4 = safeText(body.last4, 4).replace(/\D/g, "");
    const holderName = safeText(body.holderName, 120);
    const notes = safeText(body.notes, 1000);
    const status = isCorporateCardStatus(body.status) ? body.status : "active";
    const kind = isCardKind(body.kind) ? body.kind : "corporate";
    const limitCents = Math.max(0, Math.round(Number(body.limitCents) || 0));
    const bestPurchaseDay = Math.round(Number(body.bestPurchaseDay) || 0);
    const closingDay = Math.round(Number(body.closingDay) || 0);
    const dueDay = Math.round(Number(body.dueDay) || 0);

    const draftError = validateCorporateCardDraft({
      name,
      last4,
      bestPurchaseDay,
      closingDay,
      dueDay,
    });
    if (draftError) return jsonResponse({ error: draftError }, 400);

    let companyId = safeText(body.companyId, 80);
    if (!allStores) companyId = scopeActor.companyId;
    if (!hasCompany(companyId)) return jsonResponse({ error: "SELECIONE A UNIDADE." }, 400);

    const database = await getD1();
    const companies = await loadCompanyList(database);
    const companyName = companies.find((row) => row.id === companyId)?.name ?? "";
    if (!companyName) return jsonResponse({ error: "UNIDADE NÃO ENCONTRADA." }, 400);

    const who = actor.displayName || "Administrador";
    if (editId) {
      const existing = await database
        .prepare("SELECT company_id AS companyId FROM finance_corporate_cards WHERE id=?1")
        .bind(editId)
        .first<{ companyId: string }>();
      if (!existing) return jsonResponse({ error: "CARTÃO NÃO ENCONTRADO." }, 404);
      if (!allStores && existing.companyId !== scopeActor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO PODE EDITAR ESTE CARTÃO." }, 403);
      }
      await database
        .prepare(
          `UPDATE finance_corporate_cards
           SET name=?1, bank=?2, brand=?3, last4=?4, limit_cents=?5, best_purchase_day=?6,
               closing_day=?7, due_day=?8, holder_name=?9, company_id=?10, company_name=?11,
               status=?12, kind=?13, notes=?14, updated_by=?15, updated_by_name=?16, updated_at=now()::text
           WHERE id=?17`,
        )
        .bind(
          name,
          bank,
          brand,
          last4,
          limitCents,
          bestPurchaseDay,
          closingDay,
          dueDay,
          holderName,
          companyId,
          companyName,
          status,
          kind,
          notes,
          actor.id,
          who,
          editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_corporate_cards
          (id, name, bank, brand, last4, limit_cents, best_purchase_day, closing_day, due_day,
           holder_name, company_id, company_name, status, kind, notes,
           created_by, created_by_name, updated_by, updated_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?16, ?17)`,
      )
      .bind(
        id,
        name,
        bank,
        brand,
        last4,
        limitCents,
        bestPurchaseDay,
        closingDay,
        dueDay,
        holderName,
        companyId,
        companyName,
        status,
        kind,
        notes,
        actor.id,
        who,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o cartão corporativo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O CARTÃO CORPORATIVO." }, 500);
  }
}
