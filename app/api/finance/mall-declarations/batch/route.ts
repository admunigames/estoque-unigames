import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../shared";
import { insertDeclarationStatement, parseDeclarationValues } from "../shared";

// Declaração de Vendas — cadastro em lote de uma competência.
// GET ?month=AAAA-MM: contexto do mês por loja (faturamento cadastrado em
//   finance_store_revenue, declaração já existente e o percentual/mínimo da
//   última declaração da loja). Usado pelo diálogo individual e pelo lote.
// POST { competenceMonth, rows[] }: grava numa transação só as lojas sem
//   declaração no mês; devolve quantas criou e quais pulou (e por quê).

type StoreContext = {
  revenueCents: number | null;
  existingId: string;
  lastContractPercentBps: number;
  lastMinimumRentCents: number;
};

async function monthContext(database: Awaited<ReturnType<typeof getD1>>, month: string) {
  const stores: Record<string, StoreContext> = {};
  const store = (id: string) =>
    (stores[id] ??= { revenueCents: null, existingId: "", lastContractPercentBps: 0, lastMinimumRentCents: 0 });
  const [revenues, declarations] = await Promise.all([
    database
      .prepare("SELECT store_id AS storeId, amount_cents AS amountCents FROM finance_store_revenue WHERE month=?1")
      .bind(month)
      .all<{ storeId: string; amountCents: number }>(),
    database
      .prepare(
        `SELECT id, company_id AS companyId, competence_month AS competenceMonth,
                contract_percent_bps AS contractPercentBps, minimum_rent_cents AS minimumRentCents
         FROM finance_mall_declarations ORDER BY competence_month DESC, updated_at DESC`,
      )
      .all<{ id: string; companyId: string; competenceMonth: string; contractPercentBps: number; minimumRentCents: number }>(),
  ]);
  for (const r of revenues.results ?? []) store(r.storeId).revenueCents = Number(r.amountCents) || 0;
  const seenLast = new Set<string>();
  for (const d of declarations.results ?? []) {
    if (!d.companyId) continue;
    if (d.competenceMonth === month) {
      store(d.companyId).existingId ||= d.id;
    } else if (!seenLast.has(d.companyId)) {
      // A mais recente fora deste mês (ORDER BY competence_month DESC).
      seenLast.add(d.companyId);
      store(d.companyId).lastContractPercentBps = Number(d.contractPercentBps) || 0;
      store(d.companyId).lastMinimumRentCents = Number(d.minimumRentCents) || 0;
    }
  }
  return stores;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME A COMPETÊNCIA (AAAA-MM)." }, 400);
  try {
    const database = await getD1();
    return jsonResponse({ month, stores: await monthContext(database, month) });
  } catch (error) {
    console.error("Não foi possível carregar o contexto da declaração de vendas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O FATURAMENTO DO MÊS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DECLARAÇÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const competenceMonth = safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) return jsonResponse({ error: "INFORME A COMPETÊNCIA (AAAA-MM)." }, 400);
    const rows = Array.isArray(body.rows) ? (body.rows as JsonMap[]) : [];
    if (!rows.length) return jsonResponse({ error: "NENHUMA LOJA COM VALOR DECLARADO." }, 400);
    if (rows.length > 200) return jsonResponse({ error: "LOTE GRANDE DEMAIS (MÁX. 200 LOJAS)." }, 400);

    const database = await getD1();
    const context = await monthContext(database, competenceMonth);
    const who = actor.displayName || "Administrador";
    const skipped: Array<{ companyId: string; companyName: string; reason: string }> = [];
    const statements = [];
    const seen = new Set<string>();

    for (const raw of rows) {
      const row = raw && typeof raw === "object" ? raw : {};
      const companyId = safeText(row.companyId, 80);
      const companyName = safeText(row.companyName, 160);
      const skip = (reason: string) => skipped.push({ companyId, companyName, reason });
      if (!companyId) { skip("LOJA NÃO INFORMADA"); continue; }
      if (seen.has(companyId)) { skip("LOJA REPETIDA NO LOTE"); continue; }
      seen.add(companyId);
      if (row.declaredCents === undefined || row.declaredCents === null || row.declaredCents === "") {
        skip("SEM VALOR DECLARADO");
        continue;
      }
      if (context[companyId]?.existingId) { skip("JÁ CADASTRADA NO MÊS"); continue; }
      const values = parseDeclarationValues(row);
      if ("error" in values) { skip(values.error); continue; }
      statements.push(
        insertDeclarationStatement(database, {
          ...values,
          // Faturamento cadastrado tem prioridade; o digitado só vale sem ele.
          realRevenueCents: context[companyId]?.revenueCents ?? values.realRevenueCents,
          id: crypto.randomUUID(),
          companyId,
          companyName,
          competenceMonth,
          percentageRentPaid: 0,
          notes: safeText(row.notes, 2000),
          actorId: actor.id,
          who,
        }),
      );
    }

    if (statements.length) await database.batch(statements);
    return jsonResponse({ created: statements.length, skipped }, statements.length ? 201 : 200);
  } catch (error) {
    console.error("Não foi possível salvar o lote de declarações de vendas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LOTE. NADA FOI GRAVADO." }, 500);
  }
}
