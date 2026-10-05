import { getD1 } from "../../../../../db";
import { computeCreditSale, creditSaleStatus, withoutDepositNote } from "../../../../lib/credit-sales";
import { jsonResponse, safeText, type JsonMap } from "../../shared";
import { runStatements, type Statement } from "../../card-fees/shared";
import {
  bodyIds,
  creditScope,
  DATE_RE,
  inScope,
  loadCreditSalesByIds,
  loadProviders,
  loadTakenProposals,
  proposalKey,
  releaseEntryStatements,
} from "../shared";

// Ações em lote nos Crediários (Financeiro 7/9): { action, ids, fields }
// - finish: MARCAR COMO FINALIZADO (fields.date; sem extrato, recebido = sem taxa);
// - pending: VOLTAR PARA PENDENTE (desfaz o vínculo com o extrato e o cancelamento);
// - provider: ALTERAR FINANCEIRA/TAXA (fields.providerId, fields.feeBps opcional
//   = taxa padrão da financeira; recalcula o sem taxa);
// - cancel: CANCELAR (também solta o depósito);
// - delete: EXCLUIR.
// A entrada do extrato que fica sem crediário volta para 'pending'. Todos os
// ids conferidos antes (404/403); gravação numa transação.

const ACTIONS = ["finish", "pending", "provider", "cancel", "delete"];

export async function POST(request: Request) {
  const scope = creditScope(request, true);
  if (scope instanceof Response) return scope;
  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 12);
    if (!ACTIONS.includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = bodyIds(body.ids);
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM CREDIÁRIO." }, 400);
    if (ids.length > 1000) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 1000)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const rows = await loadCreditSalesByIds(database, ids);
    if (rows.length !== ids.length) return jsonResponse({ error: "ALGUM CREDIÁRIO SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    if (rows.some((row) => !inScope(scope, row.companyId))) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ALGUM CREDIÁRIO SELECIONADO." }, 403);
    }

    const actor = scope.actor;
    const who = actor.displayName || "Administrador";
    const statements: Statement[] = [];
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const skip = (row: { id: string; proposal: string }, reason: string) => skipped.push({ id: row.id, description: row.proposal, reason });
    const released: string[] = [];

    if (action === "finish") {
      const date = safeText(fields.date, 10);
      if (!DATE_RE.test(date)) return jsonResponse({ error: "INFORME A DATA DO RECEBIMENTO." }, 400);
      for (const row of rows) {
        const status = creditSaleStatus(row);
        if (status !== "pending") {
          skip(row, status === "canceled" ? "CANCELADO" : "JÁ FINALIZADO");
          continue;
        }
        statements.push([
          `UPDATE finance_credit_sales SET received_date=?1, received_cents=net_cents, bank_entry_id='',
             updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
          [date, actor.id, who, row.id],
        ]);
      }
    } else if (action === "provider") {
      const providers = await loadProviders(database, scope);
      const provider = providers.find((row) => row.id === safeText(fields.providerId, 80));
      if (!provider || provider.status !== "active") return jsonResponse({ error: "ESCOLHA UMA FINANCEIRA ATIVA." }, 400);
      const feeBps = fields.feeBps === undefined || fields.feeBps === null || fields.feeBps === "" ? provider.defaultFeeBps : Number(fields.feeBps);
      const taken = await loadTakenProposals(database, [provider.id]);
      for (const row of rows) if (row.providerId === provider.id) taken.delete(proposalKey(provider.id, row.proposal));
      for (const row of rows) {
        if (provider.companyId && provider.companyId !== row.companyId) {
          skip(row, "A FINANCEIRA NÃO ATENDE ESSA UNIDADE");
          continue;
        }
        const key = proposalKey(provider.id, row.proposal);
        if (row.proposal && taken.has(key)) {
          skip(row, "PROPOSTA JÁ CADASTRADA NESSA FINANCEIRA");
          continue;
        }
        taken.add(key);
        const amounts = computeCreditSale({ grossCents: row.grossCents, feeBps });
        if (!amounts) return jsonResponse({ error: "TAXA INVÁLIDA." }, 400);
        statements.push([
          `UPDATE finance_credit_sales SET provider_id=?1, provider_name=?2, fee_bps=?3, fee_cents=?4, net_cents=?5,
             updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP WHERE id=?8`,
          [provider.id, provider.name, amounts.feeBps, amounts.feeCents, amounts.netCents, actor.id, who, row.id],
        ]);
      }
    } else {
      for (const row of rows) {
        if (action === "cancel" && row.canceled) {
          skip(row, "JÁ CANCELADO");
          continue;
        }
        if (action === "pending" && creditSaleStatus(row) === "pending") {
          skip(row, "JÁ ESTÁ PENDENTE");
          continue;
        }
        released.push(row.bankEntryId);
        statements.push(
          action === "delete"
            ? ["DELETE FROM finance_credit_sales WHERE id=?1", [row.id]]
            : [
                `UPDATE finance_credit_sales SET canceled=?1, bank_entry_id='', received_date='', received_cents=0, notes=?2,
                   updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
                [action === "cancel" ? 1 : 0, withoutDepositNote(row.notes), actor.id, who, row.id],
              ],
        );
      }
    }
    const applied = statements.length;
    await runStatements(database, [...statements, ...releaseEntryStatements(released, actor)]);
    return jsonResponse({ applied, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de crediários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APLICAR O LOTE DE CREDIÁRIOS." }, 500);
  }
}
