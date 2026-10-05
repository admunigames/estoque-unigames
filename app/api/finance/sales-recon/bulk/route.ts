import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { type PaymentMethod, type SaleKind } from "../../../../lib/sales-recon";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runStatements, scopeActorOf, type Statement } from "../../card-fees/shared";
import { loadMatchContext, matchReconRow } from "../shared";

// Ações em lote em VENDAS DO PONTTIE (Financeiro 6/9):
// { action, ids, fields }:
// - sale / service: MARCAR COMO VENDA / SERVIÇO (kind_source 'manual' — a
//   classificação automática nunca mais sobrescreve) e recalcula a unidade;
// - machine: DEFINIR MAQUINETA (fields.machineId) e recalcula a unidade;
// - ignore: IGNORAR (não entra no faturamento, ex.: cancelada);
// - rematch: CONCILIAR DE NOVO (casa outra vez com maquineta/extrato — útil
//   depois de importar o arquivo da maquineta ou o extrato; também desfaz o
//   IGNORAR);
// - delete: EXCLUIR.
// Todos os ids conferidos antes (404/403); gravação numa transação.

const ACTIONS = ["sale", "service", "machine", "ignore", "rematch", "delete"];

type Row = {
  id: string;
  companyId: string;
  saleDate: string;
  saleRef: string;
  paymentMethod: PaymentMethod;
  amountCents: number;
  authorizationCode: string;
  terminalRef: string;
  kind: SaleKind;
  machineId: string;
  status: string;
};

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR A CONCILIAÇÃO DE VENDAS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (!ACTIONS.includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA VENDA." }, 400);
    if (ids.length > 2000) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 2000)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;
    const machineId = safeText(fields.machineId, 80);

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, company_id AS companyId, sale_date AS saleDate, sale_ref AS saleRef, payment_method AS paymentMethod,
                amount_cents AS amountCents, authorization_code AS authorizationCode, terminal_ref AS terminalRef,
                kind, machine_id AS machineId, status
         FROM finance_sales_recon_rows WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...ids)
      .all<Row>();
    const rows = found.results ?? [];
    if (rows.length !== ids.length) {
      return jsonResponse({ error: "ALGUMA VENDA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    }
    if (!allStores && rows.some((row) => row.companyId !== scopeActor.companyId)) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ALGUMA VENDA SELECIONADA." }, 403);
    }
    if (action === "machine") {
      const machine = await database.prepare("SELECT id FROM finance_card_machines WHERE id=?1").bind(machineId).first();
      if (!machine) return jsonResponse({ error: "ESCOLHA UMA MAQUINETA CADASTRADA." }, 400);
    }

    const who = actor.displayName || "Administrador";
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const statements: Statement[] = [];
    if (action === "delete" || action === "ignore") {
      for (const row of rows) {
        statements.push(
          action === "delete"
            ? ["DELETE FROM finance_sales_recon_rows WHERE id=?1", [row.id]]
            : [
                `UPDATE finance_sales_recon_rows SET status='ignored', updated_by=?1, updated_by_name=?2,
                   updated_at=CURRENT_TIMESTAMP WHERE id=?3`,
                [actor.id, who, row.id],
              ],
        );
      }
    } else {
      const dates = rows.map((row) => row.saleDate).sort();
      // As próprias linhas liberam o que já usavam (rematch pode trocar).
      const ctx = await loadMatchContext(database, { from: dates[0], to: dates[dates.length - 1] }, action === "rematch" ? ids : []);
      for (const row of rows) {
        const kind: SaleKind = action === "sale" ? "sale" : action === "service" ? "service" : row.kind;
        if (action === "rematch") {
          const match = matchReconRow(ctx, { ...row, kind });
          statements.push([
            `UPDATE finance_sales_recon_rows SET machine_id=?1, card_sale_id=?2, bank_entry_id=?3, status=?4,
               revenue_company_id=?5, updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP WHERE id=?8`,
            [match.machineId, match.cardSaleId, match.bankEntryId, match.status, match.revenueCompanyId, actor.id, who, row.id],
          ]);
          continue;
        }
        // Venda/serviço/maquineta: só a unidade do faturamento muda; o
        // casamento com maquineta/extrato fica como estava.
        const nextMachine = action === "machine" ? machineId : row.machineId;
        const match = matchReconRow(
          { ...ctx, cardSales: [], bankCredits: [] },
          { ...row, kind, machineId: nextMachine, terminalRef: "" },
        );
        statements.push(
          action === "machine"
            ? [
                `UPDATE finance_sales_recon_rows SET machine_id=?1, revenue_company_id=?2, updated_by=?3, updated_by_name=?4,
                   updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
                [nextMachine, match.revenueCompanyId, actor.id, who, row.id],
              ]
            : [
                `UPDATE finance_sales_recon_rows SET kind=?1, kind_source='manual', revenue_company_id=?2,
                   updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
                [kind, match.revenueCompanyId, actor.id, who, row.id],
              ],
        );
      }
    }
    await runStatements(database, statements);
    return jsonResponse({ applied: statements.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote da conciliação de vendas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APLICAR O LOTE DA CONCILIAÇÃO DE VENDAS." }, 500);
  }
}
