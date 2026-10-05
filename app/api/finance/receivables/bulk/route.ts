import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import {
  assertReceivableAccess,
  cancelReceivableStatement,
  loadReceivable,
  parseReceived,
  receiveReceivableStatement,
  type ReceivableRow,
} from "../shared";

// Ações em lote nos recebíveis: { action: 'receive' | 'cancel', ids[], fields }.
// - receive: valor recebido = valor previsto, na data fields.receivedDate
//   (validação de parseReceived, a mesma do PUT [id]);
// - cancel: cancelamento SOFT, igual ao POST [id]/cancel.
// Todos os ids conferidos antes (404 se algum sumiu, 403 se for de outra
// loja); gravação numa transação. Cancelado ou já recebido é pulado.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR RECEBÍVEIS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "receive" && action !== "cancel") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM RECEBÍVEL." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 500)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const rows: ReceivableRow[] = [];
    for (const id of ids) {
      const row = await loadReceivable(database, id);
      if (!row) return jsonResponse({ error: "ALGUM RECEBÍVEL SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
      const accessError = assertReceivableAccess(scopeActor, row);
      if (accessError) return jsonResponse({ error: accessError }, 403);
      rows.push(row);
    }

    const skipped: Array<{ id: string; label: string; reason: string }> = [];
    const statements: ReturnType<typeof database.prepare>[] = [];
    for (const row of rows) {
      const skip = (reason: string) => skipped.push({ id: row.id, label: `${row.operatorText} ${row.competenceMonth}`, reason });
      if (Number(row.canceled) === 1) { skip("JÁ CANCELADO"); continue; }
      if (action === "cancel") {
        statements.push(cancelReceivableStatement(database, row.id, actor));
        continue;
      }
      if (row.receivedAmountCents !== null && row.receivedAmountCents !== undefined) { skip("JÁ RECEBIDO"); continue; }
      const received = parseReceived({ receivedAmountCents: row.expectedAmountCents, receivedDate: fields.receivedDate });
      if (received.error || received.receivedAmountCents === null) {
        return jsonResponse({ error: received.error || "INFORME A DATA DO RECEBIMENTO." }, 400);
      }
      statements.push(
        receiveReceivableStatement(database, row.id, { receivedAmountCents: received.receivedAmountCents, receivedDate: received.receivedDate }, actor),
      );
    }

    if (statements.length) await database.batch(statements);
    return jsonResponse({ applied: rows.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar a ação em lote nos recebíveis.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
