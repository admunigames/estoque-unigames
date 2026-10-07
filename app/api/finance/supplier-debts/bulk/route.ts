import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { planPayablesBulk } from "../../payables/shared";
import { assertSupplierDebtAccess, loadSupplierDebt, type SupplierDebtRow } from "../shared";

// Ações em lote de FORNECEDORES EM ABERTO (Financeiro 9/9): { action: 'pay' |
// 'cancel', ids: debtIds[], fields }. Cada dívida tem a conta a pagar gêmea
// (accounts_payable_id), que é onde a tela registra o pagamento — então o lote
// age sobre as gêmeas pela MESMA função de Contas a Pagar (planPayablesBulk);
// cancelar a gêmea cancela a dívida junto. Uma transação só.

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR DÍVIDAS DE FORNECEDORES." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "pay" && action !== "cancel") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA DÍVIDA." }, 400);
    if (ids.length > 300) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 300)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const debts: SupplierDebtRow[] = [];
    for (const id of ids) {
      const debt = await loadSupplierDebt(database, id);
      if (!debt) return jsonResponse({ error: "ALGUMA DÍVIDA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
      const accessError = assertSupplierDebtAccess(scopeActor, debt);
      if (accessError) return jsonResponse({ error: accessError }, 403);
      debts.push(debt);
    }
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const live = debts.filter((debt) => {
      if (debt.canceled) skipped.push({ id: debt.id, description: debt.description, reason: "DÍVIDA CANCELADA" });
      return !debt.canceled;
    });
    const debtOfPayable = new Map(live.map((debt) => [debt.accountsPayableId, debt]));
    let applied = 0;
    if (live.length) {
      const plan = await planPayablesBulk(database, actor, scopeActor, action, [...debtOfPayable.keys()], {
        ...fields,
        notes: "PAGO EM LOTE EM FORNECEDORES EM ABERTO",
      });
      if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
      if (plan.statements.length) await database.batch(plan.statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
      applied = plan.applied;
      for (const item of plan.skipped) {
        const debt = debtOfPayable.get(item.id);
        skipped.push({ id: debt?.id ?? item.id, description: debt?.description ?? item.description, reason: item.reason });
      }
    }
    return jsonResponse({ applied, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de dívidas de fornecedores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
