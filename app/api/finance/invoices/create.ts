import type { getD1 } from "../../../../db";
import { isValidCpfOrCnpj } from "../../../lib/br-documents";
import { computeInvoiceFinancialStatus } from "../../../lib/supplier-invoice-status";
import { safeText, MONTH_PATTERN, type JsonMap } from "../shared";
import { DATE_PATTERN } from "../payables/shared";

// Valida o corpo de UMA nota fiscal e monta os SQL (NF + evento) sem executar
// — usada pelo POST (NF manual ou do pedido de compra) e pelo CADASTRAR EM
// LOTE (invoices/batch).
export async function planInvoiceCreate(
  database: Awaited<ReturnType<typeof getD1>>,
  actor: { id: string; displayName: string },
  scopeActor: { companyId: string },
  allStores: boolean,
  viaPurchaseOrder: boolean,
  body: JsonMap,
): Promise<{ reply: { payload: JsonMap; status: number } } | { id: string; purchaseOrderId: string; statements: [string, unknown[]][] }> {
  const reply = (payload: JsonMap, status = 200) => ({ reply: { payload, status } });
  // Loja OPCIONAL (escritório / PF / outros) — só para quem vê todas as lojas.
  const companyId = safeText(body.companyId, 80);
  const companyName = companyId ? safeText(body.companyName, 160) : "";
  if (!companyId && !allStores) return reply({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
  const payerName = safeText(body.payerName, 160);
  if (!allStores && companyId !== scopeActor.companyId) {
    return reply({ error: "VOCÊ SÓ PODE CADASTRAR NOTAS PARA A PRÓPRIA LOJA." }, 403);
  }

  const invoiceNumber = safeText(body.invoiceNumber, 60);
  if (!invoiceNumber) return reply({ error: "INFORME O NÚMERO DA NOTA FISCAL." }, 400);
  const series = safeText(body.series, 20);
  const accessKey = safeText(body.accessKey, 44);
  if (accessKey && !/^\d{44}$/.test(accessKey)) {
    return reply({ error: "A CHAVE DE ACESSO DA NF-E DEVE TER 44 DÍGITOS." }, 400);
  }
  const supplierId = safeText(body.supplierId, 80);
  const supplierDocument = safeText(body.supplierDocument, 20);
  if (supplierDocument && !isValidCpfOrCnpj(supplierDocument)) {
    return reply({ error: "O CNPJ/CPF DO FORNECEDOR É INVÁLIDO." }, 400);
  }

  const totalAmountCents = Number(body.totalAmountCents);
  if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
    return reply({ error: "INFORME UM VALOR TOTAL VÁLIDO EM CENTAVOS." }, 400);
  }

  const issueDate = safeText(body.issueDate, 10);
  if (issueDate && !DATE_PATTERN.test(issueDate)) return reply({ error: "DATA DE EMISSÃO INVÁLIDA." }, 400);
  const entryDate = safeText(body.entryDate, 10);
  if (entryDate && !DATE_PATTERN.test(entryDate)) return reply({ error: "DATA DE ENTRADA INVÁLIDA." }, 400);

  const competenceMonth = safeText(body.competenceMonth, 7);
  if (!MONTH_PATTERN.test(competenceMonth)) {
    return reply({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
  }

  const financeItemId = safeText(body.financeItemId, 80);
  let financeCategoryId = safeText(body.financeCategoryId, 80);
  if (financeItemId && !financeCategoryId) {
    // Campo único CATEGORIA: o item já traz a categoria.
    const item = await database
      .prepare("SELECT category_id AS categoryId FROM finance_items WHERE id=?1")
      .bind(financeItemId)
      .first<{ categoryId: string }>();
    if (!item) return reply({ error: "CATEGORIA NÃO ENCONTRADA NO CATÁLOGO FINANCEIRO." }, 400);
    financeCategoryId = item.categoryId;
  }
  const notes = safeText(body.notes, 2000);
  // Vínculo opcional com um pedido nativo (Compras Fase C) — só usado
  // quando a NF nasce do botão "Criar Nota Fiscal para este pedido" no
  // detalhe do pedido; fluxo manual normal segue sem preencher isto.
  const purchaseOrderId = safeText(body.purchaseOrderId, 80);

  if (viaPurchaseOrder) {
    const order = await database
      .prepare("SELECT id FROM purchase_orders WHERE id=?1 AND origin='native' AND canceled=0")
      .bind(purchaseOrderId)
      .first<{ id: string }>();
    if (!order) return reply({ error: "PEDIDO DE COMPRA NÃO ENCONTRADO." }, 404);
  }

  const costCenterId = safeText(body.costCenterId, 80);
  let costCenter = "";
  if (costCenterId) {
    const costCenterRow = await database
      .prepare("SELECT name FROM finance_cost_centers WHERE id=?1")
      .bind(costCenterId)
      .first<{ name: string }>();
    if (!costCenterRow) return reply({ error: "CENTRO DE CUSTO NÃO ENCONTRADO." }, 400);
    costCenter = costCenterRow.name;
  }

  const duplicate = await database
    .prepare(
      `SELECT id FROM supplier_invoices
       WHERE company_id=?1 AND supplier_id=?2 AND invoice_number=?3 AND series=?4`,
    )
    .bind(companyId, supplierId, invoiceNumber, series)
    .first<{ id: string }>();
  if (duplicate) {
    return reply(
      { error: "JÁ EXISTE UMA NOTA FISCAL CADASTRADA COM ESSE NÚMERO/SÉRIE PARA ESSE FORNECEDOR E LOJA." },
      409,
    );
  }
  if (accessKey) {
    const duplicateKey = await database
      .prepare("SELECT id FROM supplier_invoices WHERE access_key=?1")
      .bind(accessKey)
      .first<{ id: string }>();
    if (duplicateKey) {
      return reply({ error: "JÁ EXISTE UMA NOTA FISCAL CADASTRADA COM ESSA CHAVE DE ACESSO." }, 409);
    }
  }

  const actorName = actor.displayName || "Administrador";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  // NF manual entra direto no Financeiro (não passa por Compras) — já
  // conta como "enviada", só falta a etapa explícita de conferência.
  const financialStatus = computeInvoiceFinancialStatus({
    totalAmountCents,
    canceled: false,
    sentToFinance: true,
    reviewed: false,
    installments: [],
  });

  const statements: [string, unknown[]][] = [];
  statements.push([
      `INSERT INTO supplier_invoices
        (id, company_id, company_name, supplier_id, supplier_document, invoice_number, series, access_key,
         issue_date, entry_date, competence_month, notion_purchase_id, notion_purchase_url, purchase_order_id,
         total_amount_cents, finance_category_id, finance_item_id, cost_center, notes, origin, financial_status,
         created_by, created_by_name, sent_to_finance_by, sent_to_finance_by_name, sent_to_finance_at,
         created_at, updated_by, updated_by_name, updated_at, cost_center_id, payer_name)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'','',?12,?13,?14,?15,?16,?17,'manual',?18,
         ?19,?20,?19,?20,?21,CURRENT_TIMESTAMP,?19,?20,CURRENT_TIMESTAMP,?22,?23)`,
    [
      id,
      companyId,
      companyName,
      supplierId,
      supplierDocument,
      invoiceNumber,
      series,
      accessKey,
      issueDate,
      entryDate,
      competenceMonth,
      purchaseOrderId,
      totalAmountCents,
      financeCategoryId,
      financeItemId,
      costCenter,
      notes,
      financialStatus,
      actor.id,
      actorName,
      now,
      costCenterId || null,
      payerName,
    ],
  ]);
  statements.push([
    `INSERT INTO supplier_invoice_events (id, invoice_id, event_type, description, metadata_json, actor_id, actor_name, created_at)
     VALUES (?1,?2,'created','NOTA FISCAL CADASTRADA MANUALMENTE NO FINANCEIRO.','{}',?3,?4,CURRENT_TIMESTAMP)`,
    [crypto.randomUUID(), id, actor.id, actorName],
  ]);

  return { id, purchaseOrderId, statements };
}
