import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { addDays } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../shared";
import { scopeActorOf } from "../../card-fees/shared";

// CONTROLE DE REPOSIÇÃO × EXTRATO: as SAÍDAS do extrato bancário (importado
// na Conciliação Bancária) batidas com os lançamentos de reposição.
// GET ?financeAccountId&month → saídas do mês (com os lançamentos ligados e a
//   sugestão: mesmo valor, até 5 dias de diferença) + lançamentos do mês sem
//   par no extrato.
// POST { action: 'link', bankEntryId, replacementIds[] } | { action: 'unlink', replacementIds[] }.

const SUGGEST_DAYS = 5;

type Exit = { id: string; entryDate: string; description: string; amountCents: number; companyId: string; financeAccountId: string };
type Replacement = { id: string; entryDate: string; companyId: string; companyName: string; product: string; reason: string; amountCents: number; bankEntryId: string };

function scopeOf(request: Request) {
  const actor = identity(request);
  const scopeActor = scopeActorOf(request, actor);
  return { actor, scopeActor, allStores: canSeeAllStores(scopeActor, "finance:manage") };
}

function monthBounds(month: string) {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const { actor, scopeActor, allStores } = scopeOf(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const params = new URL(request.url).searchParams;
  const month = safeText(params.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  const financeAccountId = safeText(params.get("financeAccountId"), 80);
  const { from, to } = monthBounds(month);
  try {
    const database = await getD1();
    const exitConditions = ["amount_cents < 0", "entry_date >= ?1", "entry_date <= ?2"];
    const exitValues: unknown[] = [from, to];
    if (financeAccountId) { exitValues.push(financeAccountId); exitConditions.push(`finance_account_id = ?${exitValues.length}`); }
    if (!allStores) { exitValues.push(scopeActor.companyId); exitConditions.push(`company_id = ?${exitValues.length}`); }
    const [exitsResult, replacementsResult] = await Promise.all([
      database
        .prepare(
          `SELECT id, entry_date AS entryDate, description, amount_cents AS amountCents, company_id AS companyId,
                  finance_account_id AS financeAccountId
           FROM finance_bank_statement_entries WHERE ${exitConditions.join(" AND ")} ORDER BY entry_date, id LIMIT 3000`,
        )
        .bind(...exitValues)
        .all<Exit>(),
      // Lançamentos do mês (±5 dias para casar com saídas da virada) + os já ligados a saídas do mês.
      database
        .prepare(
          `SELECT id, entry_date AS entryDate, company_id AS companyId, company_name AS companyName, product, reason,
                  amount_cents AS amountCents, bank_entry_id AS bankEntryId
           FROM finance_replacement_entries
           WHERE ((entry_date >= ?1 AND entry_date <= ?2) OR bank_entry_id <> '')
           ${allStores ? "" : "AND company_id = ?3"}
           ORDER BY entry_date, id LIMIT 5000`,
        )
        .bind(addDays(from, -SUGGEST_DAYS), addDays(to, SUGGEST_DAYS), ...(allStores ? [] : [scopeActor.companyId]))
        .all<Replacement>(),
    ]);
    const exits = (exitsResult.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
    const replacements = (replacementsResult.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
    const byExit = new Map<string, Replacement[]>();
    for (const item of replacements) if (item.bankEntryId) byExit.set(item.bankEntryId, [...(byExit.get(item.bankEntryId) ?? []), item]);
    const free = replacements.filter((item) => !item.bankEntryId);
    const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
    return jsonResponse({
      month,
      exits: exits.map((exit) => {
        const linked = byExit.get(exit.id) ?? [];
        const suggestion = linked.length
          ? null
          : free.find((item) => item.amountCents === Math.abs(exit.amountCents) && dayDiff(item.entryDate, exit.entryDate) <= SUGGEST_DAYS) ?? null;
        return { ...exit, linked, linkedCents: linked.reduce((sum, item) => sum + item.amountCents, 0), suggestionId: suggestion?.id ?? "" };
      }),
      // Sem par: lançamentos do próprio mês ainda não ligados a nenhuma saída.
      unmatched: free.filter((item) => item.entryDate >= from && item.entryDate <= to),
      free,
    });
  } catch (error) {
    console.error("Não foi possível carregar o extrato da reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O EXTRATO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const { actor, scopeActor, allStores } = scopeOf(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O CONTROLE DE REPOSIÇÃO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 10);
    if (action !== "link" && action !== "unlink") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.replacementIds) ? body.replacementIds : []).map((v) => safeText(v, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM LANÇAMENTO DE REPOSIÇÃO." }, 400);
    if (ids.length > 200) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 200)." }, 400);
    const database = await getD1();
    const found = await database
      .prepare(`SELECT id, company_id AS companyId, bank_entry_id AS bankEntryId FROM finance_replacement_entries WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...ids)
      .all<{ id: string; companyId: string; bankEntryId: string }>();
    const rows = found.results ?? [];
    if (rows.length !== ids.length) return jsonResponse({ error: "ALGUM LANÇAMENTO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    if (!allStores && rows.some((row) => row.companyId !== scopeActor.companyId)) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ALGUM LANÇAMENTO SELECIONADO." }, 403);
    }
    let bankEntryId = "";
    if (action === "link") {
      bankEntryId = safeText(body.bankEntryId, 80);
      const entry = await database
        .prepare("SELECT id, company_id AS companyId, amount_cents AS amountCents FROM finance_bank_statement_entries WHERE id=?1")
        .bind(bankEntryId)
        .first<{ id: string; companyId: string; amountCents: number }>();
      if (!entry) return jsonResponse({ error: "LANÇAMENTO DO EXTRATO NÃO ENCONTRADO." }, 404);
      if (Number(entry.amountCents) >= 0) return jsonResponse({ error: "SÓ SAÍDAS DO EXTRATO (VALOR NEGATIVO) BATEM COM A REPOSIÇÃO." }, 400);
      if (!allStores && entry.companyId !== scopeActor.companyId) return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSE LANÇAMENTO DO EXTRATO." }, 403);
      const taken = rows.find((row) => row.bankEntryId && row.bankEntryId !== bankEntryId);
      if (taken) return jsonResponse({ error: "ALGUM LANÇAMENTO JÁ ESTÁ LIGADO A OUTRA SAÍDA DO EXTRATO — DESFAÇA ANTES." }, 409);
    }
    const who = actor.displayName || "Administrador";
    await database.batch(
      rows.map((row) =>
        database
          .prepare("UPDATE finance_replacement_entries SET bank_entry_id=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4")
          .bind(bankEntryId, actor.id, who, row.id),
      ),
    );
    return jsonResponse({ applied: rows.length, skipped: [] });
  } catch (error) {
    console.error("Não foi possível bater a reposição com o extrato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL BATER COM O EXTRATO." }, 500);
  }
}
