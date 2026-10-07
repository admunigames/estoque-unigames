import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../shared";

// Ações em lote do ORÇAMENTO (Financeiro 9/9): { action, ids, fields }
// - copy: COPIAR PARA OUTRO MÊS (fields.month) — o "cadastrar em lote" do
//   módulo; o que já existe lá (mesma loja/categoria/centro de custo) é pulado;
// - adjust: AJUSTAR VALOR — fields.mode 'percent' (fields.percentBps, ex.: 1000
//   = +10%, -500 = −5%) ou 'fixed' (fields.deltaCents, + ou −); valor que
//   ficaria ≤ 0 é pulado (o cadastro exige valor maior que zero);
// - delete: EXCLUIR (igual ao individual).
// Mesmo escopo das rotas atuais (finance:manage). Ids conferidos antes (404); uma transação.

type Budget = { id: string; companyId: string; companyName: string; categoryId: string; costCenterId: string; month: string; amountCents: number; notes: string };

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR ORÇAMENTOS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (!["copy", "adjust", "delete"].includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM ORÇAMENTO." }, 400);
    if (ids.length > 1000) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 1000)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;
    const targetMonth = safeText(fields.month, 7);
    const mode = safeText(fields.mode, 10);
    const percentBps = Math.round(Number(fields.percentBps));
    const deltaCents = Math.round(Number(fields.deltaCents));
    if (action === "copy" && !MONTH_PATTERN.test(targetMonth)) return jsonResponse({ error: "INFORME O MÊS DE DESTINO (AAAA-MM)." }, 400);
    if (action === "adjust") {
      if (mode === "percent" ? !Number.isFinite(percentBps) || !percentBps : mode === "fixed" ? !Number.isFinite(deltaCents) || !deltaCents : true) {
        return jsonResponse({ error: "INFORME O AJUSTE (% OU VALOR, DIFERENTE DE ZERO)." }, 400);
      }
    }

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName, category_id AS categoryId, cost_center_id AS costCenterId,
                month, amount_cents AS amountCents, notes
         FROM finance_budgets WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...ids)
      .all<Budget>();
    const budgets = found.results ?? [];
    if (budgets.length !== ids.length) return jsonResponse({ error: "ALGUM ORÇAMENTO SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);

    const who = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [];
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    let taken = new Set<string>();
    if (action === "copy") {
      const existing = await database
        .prepare("SELECT company_id AS companyId, category_id AS categoryId, cost_center_id AS costCenterId FROM finance_budgets WHERE month=?1")
        .bind(targetMonth)
        .all<{ companyId: string; categoryId: string; costCenterId: string }>();
      taken = new Set((existing.results ?? []).map((row) => `${row.companyId}|${row.categoryId}|${row.costCenterId}`));
    }
    for (const budget of budgets) {
      const skip = (reason: string) => skipped.push({ id: budget.id, description: `${budget.month} ${budget.companyName || "CONSOLIDADO"}`, reason });
      if (action === "delete") {
        statements.push(["DELETE FROM finance_budgets WHERE id=?1", [budget.id]]);
      } else if (action === "copy") {
        const key = `${budget.companyId}|${budget.categoryId}|${budget.costCenterId}`;
        if (taken.has(key)) { skip("JÁ EXISTE ORÇAMENTO NO MÊS DE DESTINO"); continue; }
        taken.add(key);
        statements.push([
          `INSERT INTO finance_budgets
            (id, company_id, company_name, category_id, cost_center_id, month, amount_cents, notes,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), budget.companyId, budget.companyName, budget.categoryId, budget.costCenterId, targetMonth,
            budget.amountCents, budget.notes, actor.id, who],
        ]);
      } else {
        const current = Number(budget.amountCents);
        const next = mode === "percent" ? Math.round((current * (10000 + percentBps)) / 10000) : current + deltaCents;
        if (next <= 0) { skip("O VALOR FICARIA ZERO OU NEGATIVO"); continue; }
        statements.push([
          "UPDATE finance_budgets SET amount_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4",
          [next, actor.id, who, budget.id],
        ]);
      }
    }
    if (statements.length) await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied: budgets.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de orçamentos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
