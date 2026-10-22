import type { getD1 } from "../../../../db";
import { assertFinanceAccountBelongsToCompany, assertSlotAvailableForPayable, DATE_PATTERN, recalcPayableEntrySql } from "../payables/shared";
import { parseDreDestination, planDreDestination, recalcSlotsSql } from "../payables/dre-destination";
import { safeText, type JsonMap } from "../shared";
import { DEFAULT_SUPPLIER_DEBT_FINANCE_ITEM_ID } from "./shared";

// Valida o corpo de UMA dívida avulsa e monta os SQL (dívida, conta a pagar
// gêmea, destino na DRE e recálculo) sem executar — usada pelo POST e pelo
// CADASTRAR EM LOTE (supplier-debts/batch).
export async function planSupplierDebtCreate(
  database: Awaited<ReturnType<typeof getD1>>,
  actor: { id: string; displayName: string },
  scopeActor: { companyId: string },
  allStores: boolean,
  body: JsonMap,
): Promise<{ reply: { payload: JsonMap; status: number } } | { statements: [string, unknown[]][]; debtId: string; payableId: string }> {
  const reply = (payload: JsonMap, status = 200) => ({ reply: { payload, status } });
  const idempotencyKey = safeText(body.idempotencyKey, 120);
  if (!idempotencyKey) return reply({ error: "REQUISIÇÃO INVÁLIDA (SEM CHAVE DE IDEMPOTÊNCIA)." }, 400);

  // Loja OPCIONAL (escritório / PF / outros) — só para quem vê todas as lojas.
  const companyId = safeText(body.companyId, 80);
  const companyName = companyId ? safeText(body.companyName, 160) : "";
  if (!companyId && !allStores) return reply({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
  const payerName = safeText(body.payerName, 160);
  if (!allStores && companyId !== scopeActor.companyId) {
    return reply({ error: "VOCÊ SÓ PODE CADASTRAR DÍVIDAS PARA A PRÓPRIA LOJA." }, 403);
  }

  const supplierId = safeText(body.supplierId, 80);
  if (!supplierId) return reply({ error: "SELECIONE O FORNECEDOR." }, 400);

  const description = safeText(body.description, 200);
  if (description.length < 2) return reply({ error: "INFORME A DESCRIÇÃO DA DÍVIDA." }, 400);

  const dueDate = safeText(body.dueDate, 10);
  if (!DATE_PATTERN.test(dueDate)) return reply({ error: "INFORME A DATA PREVISTA DE PAGAMENTO." }, 400);

  const purchaseDate = safeText(body.purchaseDate, 10);
  if (purchaseDate && !DATE_PATTERN.test(purchaseDate)) {
    return reply({ error: "DATA DA COMPRA INVÁLIDA." }, 400);
  }

  const originalAmountCents = Number(body.originalAmountCents);
  if (!Number.isFinite(originalAmountCents) || !Number.isInteger(originalAmountCents) || originalAmountCents <= 0) {
    return reply({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
  }

  const invoiceNumber = safeText(body.invoiceNumber, 60);
  const supplierInvoiceId = safeText(body.supplierInvoiceId, 80);
  const orderReference = safeText(body.orderReference, 60);
  const notes = safeText(body.notes, 2000);
  const financeItemId = safeText(body.financeItemId, 80) || DEFAULT_SUPPLIER_DEBT_FINANCE_ITEM_ID;
  const financeAccountId = safeText(body.financeAccountId, 80);


  const [supplier, item] = await Promise.all([
    database.prepare("SELECT id, name FROM finance_suppliers WHERE id=?1").bind(supplierId).first<{ id: string; name: string }>(),
    database.prepare("SELECT id FROM finance_items WHERE id=?1").bind(financeItemId).first<{ id: string }>(),
  ]);
  if (!supplier) return reply({ error: "FORNECEDOR NÃO ENCONTRADO NO CADASTRO." }, 400);
  if (!item) return reply({ error: "ITEM FINANCEIRO NÃO ENCONTRADO NO CATÁLOGO." }, 400);

  const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, companyId);
  if (accountError) return reply({ error: accountError }, 409);

  const parsedDestination = await parseDreDestination(database, body, {
    companyId,
    companyName,
    financeItemId,
    competenceMonth: dueDate.slice(0, 7),
    totalAmountCents: originalAmountCents,
    allStores,
    actorCompanyId: scopeActor.companyId,
  });
  if ("error" in parsedDestination) return reply({ error: parsedDestination.error }, parsedDestination.status);
  const destination = parsedDestination.destination;
  for (const share of destination?.shares ?? []) {
    const conflict = await assertSlotAvailableForPayable(database, share.companyId, destination!.itemId, dueDate.slice(0, 7));
    if (conflict) return reply({ error: conflict }, 409);
  }

  if (supplierInvoiceId) {
    const invoice = await database
      .prepare("SELECT id FROM supplier_invoices WHERE id=?1")
      .bind(supplierInvoiceId)
      .first<{ id: string }>();
    if (!invoice) return reply({ error: "NOTA FISCAL VINCULADA NÃO ENCONTRADA." }, 400);
  }

  const existingPayable = await database
    .prepare("SELECT id FROM accounts_payable WHERE idempotency_key=?1")
    .bind(`supplier-debt:${idempotencyKey}`)
    .first<{ id: string }>();
  if (existingPayable) {
    const existingDebt = await database
      .prepare("SELECT id FROM supplier_open_debts WHERE accounts_payable_id=?1")
      .bind(existingPayable.id)
      .first<{ id: string }>();
    return reply({ created: true, alreadyProcessed: true, id: existingDebt?.id ?? "", accountsPayableId: existingPayable.id });
  }

  const debtId = crypto.randomUUID();
  const payableId = crypto.randomUUID();
  const actorName = actor.displayName || "Administrador";
  const competenceMonth = dueDate.slice(0, 7);

  const statements: [string, unknown[]][] = [
    [
      `INSERT INTO accounts_payable
        (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
         original_amount_cents, paid_amount_cents, dre_amount_cents, issue_date, competence_month, due_date, payment_method,
         invoice_number, order_reference, billing_code, notes, status,
         idempotency_key, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, payer_name)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?20,?9,?10,?11,?12,?13,?14,'',?15,'open',
         ?16,?17,?18,CURRENT_TIMESTAMP,?17,?18,CURRENT_TIMESTAMP,?19)`,
      [
        payableId,
        companyId,
        companyName,
        description,
        supplierId,
        financeItemId,
        financeAccountId,
        originalAmountCents,
        purchaseDate,
        competenceMonth,
        dueDate,
        "",
        invoiceNumber,
        orderReference,
        notes,
        `supplier-debt:${idempotencyKey}`,
        actor.id,
        actorName,
        payerName,
        destination?.target === "none" ? 0 : null,
      ],
    ],
    [
      `INSERT INTO supplier_open_debts
        (id, company_id, company_name, supplier_id, supplier_name, invoice_number, supplier_invoice_id,
         order_reference, purchase_date, description, original_amount_cents, paid_amount_cents, due_date, notes,
         accounts_payable_id, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, payer_name)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13,?14,?15,?16,CURRENT_TIMESTAMP,?15,?16,CURRENT_TIMESTAMP,?17)`,
      [
        debtId,
        companyId,
        companyName,
        supplierId,
        supplier.name,
        invoiceNumber,
        supplierInvoiceId,
        orderReference,
        purchaseDate,
        description,
        originalAmountCents,
        dueDate,
        notes,
        payableId,
        actor.id,
        actorName,
        payerName,
      ],
    ],
  ];

  if (destination) {
    const destinationPlan = await planDreDestination(database, destination, [
      { payableId, month: competenceMonth, amountCents: destination.target === "none" ? 0 : originalAmountCents },
    ]);
    statements.push(...destinationPlan.statements, ...recalcSlotsSql(destinationPlan.slots, { id: actor.id, name: actorName }));
  } else {
    const entryId = crypto.randomUUID();
    for (const [sql, sqlValues] of recalcPayableEntrySql(entryId, companyId, financeItemId, competenceMonth, actor.id, actorName)) {
      statements.push([sql, sqlValues]);
    }
  }

  return { statements, debtId, payableId };
}
