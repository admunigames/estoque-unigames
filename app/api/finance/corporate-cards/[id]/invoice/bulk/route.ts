import { unauthorizedResponse } from "../../../../../../lib/notion";
import { applyCardEntryFields } from "../../../../../../lib/corporate-cards";
import { planExpense } from "../../../../expenses/shared";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../../shared";
import { assertCardAccess, ENTRY_COLUMNS, parseCardEntryFields, type StoredCardEntry } from "../../../shared";

// Ações em lote nos lançamentos da fatura: { action, ids[], fields }.
// - classify: aplica só os campos enviados em fields (categoria, centro de
//   custo, responsável, observação, expenseKind 'expense' | 'not_expense');
// - not-expense: atalho de classify com expenseKind 'not_expense';
// - launch: cria a Despesa de cada lançamento classificado como despesa
//   (mesma criação do POST /api/finance/expenses — planExpense) e grava o
//   expense_id; fields opcionais (categoria, centro de custo, dueDate,
//   notes) servem ao LANÇAR DESPESA de um lançamento só;
// - delete: exclui; os já LANÇADOS EM DESPESAS são pulados.
// Todos os ids são conferidos no cartão antes; a gravação vai numa
// transação só. Resposta: { applied, skipped: [{ id, merchant, reason }] }.

const ACTIONS = new Set(["classify", "not-expense", "launch", "delete"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR A FATURA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const cardId = safeText(id, 80);
  const access = await assertCardAccess(request, actor, cardId);
  if (access.error) return access.error;
  const { database, card, allStores, scopeCompanyId } = access;

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (!ACTIONS.has(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM LANÇAMENTO." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 500)." }, 400);

    const placeholders = ids.map((_, index) => `?${index + 2}`).join(",");
    const found = await database
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM finance_card_invoice_entries WHERE card_id=?1 AND id IN (${placeholders})`)
      .bind(cardId, ...ids)
      .all<StoredCardEntry>();
    const entries = found.results ?? [];
    if (entries.length !== ids.length) {
      return jsonResponse({ error: "ALGUM LANÇAMENTO SELECIONADO NÃO EXISTE MAIS NESTE CARTÃO. ATUALIZE A LISTA." }, 404);
    }

    const fields = parseCardEntryFields(body.fields);
    if (action === "not-expense") fields.expenseKind = "not_expense";
    const skipped: Array<{ id: string; merchant: string; reason: string }> = [];
    const skip = (entry: StoredCardEntry, reason: string) => skipped.push({ id: entry.id, merchant: entry.merchant, reason });
    const statements: ReturnType<typeof database.prepare>[] = [];

    if (action === "delete") {
      for (const entry of entries) {
        if (entry.expenseId) { skip(entry, "JÁ LANÇADO EM DESPESAS — EXCLUA A DESPESA NO MÓDULO DESPESAS"); continue; }
        statements.push(database.prepare("DELETE FROM finance_card_invoice_entries WHERE id=?1 AND card_id=?2").bind(entry.id, cardId));
      }
    } else if (action === "launch") {
      const dueDate = safeText((body.fields as JsonMap | undefined)?.dueDate, 10);
      if (dueDate && !DATE_RE.test(dueDate)) return jsonResponse({ error: "VENCIMENTO INVÁLIDO." }, 400);
      for (const entry of entries) {
        if (entry.expenseId) { skip(entry, "JÁ LANÇADO EM DESPESAS"); continue; }
        if (entry.status === "not_expense" && !fields.expenseKind) { skip(entry, "MARCADO COMO NÃO É DESPESA"); continue; }
        const next = applyCardEntryFields(entry, { ...fields, expenseKind: fields.expenseKind ?? "expense" });
        if ("error" in next) { skip(entry, next.error); continue; }
        if (next.status === "not_expense") { skip(entry, "MARCADO COMO NÃO É DESPESA"); continue; }
        if (!next.categoryItemId) { skip(entry, "SEM CATEGORIA — CLASSIFIQUE ANTES"); continue; }
        if (entry.amountCents <= 0) { skip(entry, "VALOR NEGATIVO/ESTORNO NÃO VIRA DESPESA"); continue; }

        const plan = await planExpense(database, actor, { allStores, companyId: scopeCompanyId }, {
          idempotencyKey: `card-entry:${entry.id}`,
          companyId: card.companyId,
          companyName: card.companyName,
          description: (entry.merchant || `Cartão ${card.name}`).slice(0, 200),
          financeItemId: next.categoryItemId,
          costCenterId: next.costCenterId,
          originalAmountCents: entry.amountCents,
          issueDate: entry.entryDate,
          dueDate: dueDate || entry.entryDate,
          paymentMethod: "CARTÃO CORPORATIVO",
          cardId,
          notes: next.notes + (entry.installmentLabel ? ` (parcela ${entry.installmentLabel})` : ""),
        });
        let expenseId = "";
        if ("reply" in plan) {
          // Idempotência: a Despesa desse lançamento já existe — só vincula.
          if (plan.reply.payload.alreadyProcessed) expenseId = String(plan.reply.payload.id || "");
          else { skip(entry, String(plan.reply.payload.error || "NÃO FOI POSSÍVEL CRIAR A DESPESA")); continue; }
        } else {
          expenseId = plan.expenseId;
          for (const [sql, values] of plan.statements) statements.push(database.prepare(sql).bind(...values));
        }
        statements.push(
          database
            .prepare(
              `UPDATE finance_card_invoice_entries
               SET expense_id=?1, status='expensed', category_item_id=?2, cost_center_id=?3, holder_name=?4, notes=?5
               WHERE id=?6`,
            )
            .bind(expenseId, next.categoryItemId, next.costCenterId, next.holderName, next.notes, entry.id),
        );
      }
    } else {
      for (const entry of entries) {
        const next = applyCardEntryFields(entry, fields);
        if ("error" in next) { skip(entry, next.error); continue; }
        statements.push(
          database
            .prepare(
              `UPDATE finance_card_invoice_entries
               SET category_item_id=?1, cost_center_id=?2, holder_name=?3, notes=?4, status=?5
               WHERE id=?6`,
            )
            .bind(next.categoryItemId, next.costCenterId, next.holderName, next.notes, next.status, entry.id),
        );
      }
    }

    if (statements.length) await database.batch(statements);
    return jsonResponse({ applied: entries.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar a ação em lote na fatura.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
