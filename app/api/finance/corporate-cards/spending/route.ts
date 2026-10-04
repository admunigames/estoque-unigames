import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText } from "../../shared";
import { scopeActorOf } from "../shared";

// Cartões Corporativos — GASTOS POR CATEGORIA.
// GET ?from=AAAA-MM&to=AAAA-MM&cardId=&companyId=&includeNotExpense=1
// Soma no servidor por categoria (category_item_id; '' = SEM CATEGORIA),
// do maior para o menor. Com &category=<id> (ou __none__) devolve também
// os lançamentos daquela categoria (clique na barra).

const NO_CATEGORY = "__none__";

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

  const params = new URL(request.url).searchParams;
  const from = safeText(params.get("from"), 7);
  const to = safeText(params.get("to"), 7);
  if (!MONTH_PATTERN.test(from) || !MONTH_PATTERN.test(to)) {
    return jsonResponse({ error: "INFORME O PERÍODO (MÊS DE / ATÉ)." }, 400);
  }
  const requestedCompany = safeText(params.get("companyId"), 80);
  if (!allStores && requestedCompany && requestedCompany !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const companyId = allStores ? requestedCompany : scopeActor.companyId;
  const cardId = safeText(params.get("cardId"), 80);
  const category = params.has("category") ? safeText(params.get("category"), 80) : null;

  // Filtro montado no código (só passa o parâmetro quando ele é usado).
  const values: unknown[] = [`${from}-01`, `${to}-31`];
  const conditions = ["e.entry_date >= ?1", "e.entry_date <= ?2"];
  const add = (fragment: string, value: unknown) => {
    values.push(value);
    conditions.push(fragment.replace("?", `?${values.length}`));
  };
  if (cardId) add("e.card_id = ?", cardId);
  if (companyId) add("e.company_id = ?", companyId);
  if (params.get("includeNotExpense") !== "1") conditions.push("e.status <> 'not_expense'");
  const where = conditions.join(" AND ");

  try {
    const database = await getD1();
    const grouped = await database
      .prepare(
        `SELECT e.category_item_id AS categoryItemId, SUM(e.amount_cents) AS totalCents, COUNT(*) AS entryCount
         FROM finance_card_invoice_entries e
         WHERE ${where}
         GROUP BY e.category_item_id`,
      )
      .bind(...values)
      .all<{ categoryItemId: string; totalCents: number; entryCount: number }>();
    const labels = await database
      .prepare(
        `SELECT i.id, i.name AS itemName, c.name AS categoryName
         FROM finance_items i LEFT JOIN finance_categories c ON c.id = i.category_id`,
      )
      .all<{ id: string; itemName: string; categoryName: string | null }>();
    const labelOf = new Map((labels.results ?? []).map((l) => [l.id, (l.categoryName ? `${l.categoryName} › ` : "") + l.itemName]));

    const categories = (grouped.results ?? [])
      .map((g) => ({
        categoryItemId: g.categoryItemId || "",
        label: g.categoryItemId ? labelOf.get(g.categoryItemId) || "CATEGORIA REMOVIDA" : "SEM CATEGORIA",
        totalCents: Number(g.totalCents) || 0,
        entryCount: Number(g.entryCount) || 0,
      }))
      .sort((a, b) => b.totalCents - a.totalCents || a.label.localeCompare(b.label));
    const totalCents = categories.reduce((sum, c) => sum + c.totalCents, 0);

    let entries: unknown[] = [];
    if (category !== null) {
      add("e.category_item_id = ?", category === NO_CATEGORY ? "" : category);
      const rows = await database
        .prepare(
          `SELECT e.id, e.entry_date AS entryDate, e.merchant, e.amount_cents AS amountCents,
                  e.installment_label AS installmentLabel, e.holder_name AS holderName, e.status,
                  e.card_id AS cardId, k.name AS cardName
           FROM finance_card_invoice_entries e
           LEFT JOIN finance_corporate_cards k ON k.id = e.card_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY e.entry_date DESC, e.id ASC LIMIT 500`,
        )
        .bind(...values)
        .all();
      entries = rows.results ?? [];
    }

    return jsonResponse({
      totalCents,
      categories: categories.map((c) => ({
        ...c,
        shareBps: totalCents ? Math.round((c.totalCents / totalCents) * 10000) : 0,
      })),
      entries,
    });
  } catch (error) {
    console.error("Não foi possível carregar os gastos por categoria.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS GASTOS POR CATEGORIA." }, 500);
  }
}
