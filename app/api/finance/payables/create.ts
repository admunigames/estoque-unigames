import type { getD1 } from "../../../../db";
import { effectiveDreAmountCents } from "../../../lib/payables-recurrence";
import { safeText, type JsonMap } from "../shared";
import { parseDreDestination, planDreDestination, recalcSlotsSql } from "./dre-destination";
import {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  assertFinanceAccountBelongsToCompany,
  assertSlotAvailableForPayable,
  competenceMonthOf,
  computeDreAnchorAssignments,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
} from "./shared";

type PayablePlanRow = {
  dueDate: string;
  competenceMonth: string;
  amountCents: number;
  installmentNumber: number;
  installmentTotal: number;
  recurrenceIndex: number;
};

// Valida o corpo de UMA conta a pagar (única, parcelada ou recorrente) e monta
// todos os SQL (contas, destino na DRE e recálculo das células) sem executar —
// usada pelo POST e pelo CADASTRAR EM LOTE (payables/batch), que junta várias
// contas numa transação só. Respostas antecipadas (erro ou idempotência) vêm
// em .reply.
export async function planPayableCreate(
  database: Awaited<ReturnType<typeof getD1>>,
  actor: { id: string; displayName: string },
  scopeActor: { companyId: string },
  allStores: boolean,
  body: JsonMap,
): Promise<{ reply: { payload: JsonMap; status: number } } | { statements: [string, unknown[]][]; ids: string[]; dreWarning: string | null }> {
  const reply = (payload: JsonMap, status = 200) => ({ reply: { payload, status } });
  const idempotencyKey = safeText(body.idempotencyKey, 120);
  if (!idempotencyKey) return reply({ error: "REQUISIÇÃO INVÁLIDA (SEM CHAVE DE IDEMPOTÊNCIA)." }, 400);

  // Loja OPCIONAL: conta SEM loja (escritório / PF / outros) só para quem
  // vê todas as lojas — login de loja continua só na própria loja.
  const companyId = safeText(body.companyId, 80);
  const companyName = companyId ? safeText(body.companyName, 160) : "";
  if (!companyId && !allStores) return reply({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
  if (!allStores && companyId !== scopeActor.companyId) {
    return reply({ error: "VOCÊ SÓ PODE CADASTRAR CONTAS PARA A PRÓPRIA LOJA." }, 403);
  }
  const payerName = safeText(body.payerName, 160);

  const description = safeText(body.description, 200);
  if (description.length < 2) return reply({ error: "INFORME A DESCRIÇÃO DA CONTA." }, 400);

  const financeItemId = safeText(body.financeItemId, 80);
  if (!financeItemId) return reply({ error: "SELECIONE A CATEGORIA/ITEM DA DESPESA." }, 400);

  const supplierId = safeText(body.supplierId, 80);
  const financeAccountId = safeText(body.financeAccountId, 80);
  const paymentMethod = safeText(body.paymentMethod, 40);
  const invoiceNumber = safeText(body.invoiceNumber, 60);
  const orderReference = safeText(body.orderReference, 60);
  const billingCode = safeText(body.billingCode, 80);
  const notes = safeText(body.notes, 2000);
  const issueDate = safeText(body.issueDate, 10);
  if (issueDate && !DATE_PATTERN.test(issueDate)) {
    return reply({ error: "DATA DE EMISSÃO INVÁLIDA." }, 400);
  }

  const firstDueDate = safeText(body.dueDate, 10);
  if (!DATE_PATTERN.test(firstDueDate)) return reply({ error: "INFORME O VENCIMENTO." }, 400);

  const totalAmountCents = Number(body.originalAmountCents);
  if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
    return reply({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
  }

  // Decisão de "Incluir na DRE?" (opcional) — quando o campo dreIncluded
  // não vem na requisição, a conta é criada com dre_amount_cents=NULL em
  // todas as linhas (comportamento padrão: entra na DRE pelo valor
  // cheio), sem precisar de nenhum tratamento especial. Só quando o
  // usuário mexeu ativamente no toggle é que a lógica de âncora entra em
  // ação — ver computeDreAnchorAssignments.
  const dreCustomized = body.dreIncluded !== undefined;
  const dreIncluded = Boolean(body.dreIncluded);
  let dreAmountCents = 0;
  let dreWarning: string | null = null;
  if (dreCustomized) {
    dreAmountCents = Number(body.dreAmountCents);
    if (!Number.isFinite(dreAmountCents) || !Number.isInteger(dreAmountCents) || dreAmountCents < 0) {
      return reply({ error: "INFORME UM VALOR VÁLIDO (EM CENTAVOS, NÃO NEGATIVO) PARA A DRE." }, 400);
    }
    if (dreIncluded && dreAmountCents > totalAmountCents) {
      dreWarning = "O VALOR INFORMADO PARA A DRE É MAIOR QUE O VALOR TOTAL DA CONTA.";
    }
  }

  const kind = safeText(body.kind, 20) || "single"; // 'single' | 'installment' | 'recurring'

  const item = await database
    .prepare("SELECT id FROM finance_items WHERE id=?1")
    .bind(financeItemId)
    .first<{ id: string }>();
  if (!item) return reply({ error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO." }, 400);

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

  const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, companyId);
  if (accountError) return reply({ error: accountError }, 409);

  const existingByKey = await database
    .prepare("SELECT id FROM accounts_payable WHERE idempotency_key=?1")
    .bind(idempotencyKey)
    .first<{ id: string }>();
  if (existingByKey) {
    return reply({ created: true, alreadyProcessed: true, ids: [existingByKey.id] });
  }

  let plan: PayablePlanRow[];
  let recurrenceId: string | null = null;
  let installmentGroupId: string | null = null;
  let recurrenceFrequency = "";
  let recurrenceOccurrenceCount: number | null = null;
  let recurrenceEndDate = "";

  if (kind === "installment") {
    const installmentTotal = Math.trunc(Number(body.installmentTotal));
    if (!Number.isInteger(installmentTotal) || installmentTotal < 2 || installmentTotal > 360) {
      return reply({ error: "INFORME A QUANTIDADE DE PARCELAS (MÍNIMO 2)." }, 400);
    }
    const amounts = splitIntoInstallments(totalAmountCents, installmentTotal);
    const dueDates = generateInstallmentDueDates(firstDueDate, installmentTotal);
    installmentGroupId = crypto.randomUUID();
    plan = dueDates.map((dueDate, index) => ({
      dueDate,
      competenceMonth: competenceMonthOf(dueDate),
      amountCents: amounts[index],
      installmentNumber: index + 1,
      installmentTotal,
      recurrenceIndex: 0,
    }));
  } else if (kind === "recurring") {
    const frequency = safeText(body.recurrenceFrequency, 20) as RecurrenceFrequency;
    if (!RECURRENCE_FREQUENCIES.includes(frequency)) {
      return reply({ error: "FREQUÊNCIA DE RECORRÊNCIA INVÁLIDA." }, 400);
    }
    const occurrenceCountRaw = body.recurrenceOccurrenceCount;
    const occurrenceCount =
      occurrenceCountRaw === undefined || occurrenceCountRaw === null || occurrenceCountRaw === ""
        ? null
        : Math.trunc(Number(occurrenceCountRaw));
    const endDate = safeText(body.recurrenceEndDate, 10);
    if (!occurrenceCount && !DATE_PATTERN.test(endDate)) {
      return reply(
        { error: "INFORME A QUANTIDADE DE OCORRÊNCIAS OU UMA DATA FINAL DA RECORRÊNCIA." },
        400,
      );
    }
    if (occurrenceCount !== null && (!Number.isInteger(occurrenceCount) || occurrenceCount < 1 || occurrenceCount > 260)) {
      return reply({ error: "QUANTIDADE DE OCORRÊNCIAS INVÁLIDA." }, 400);
    }
    const dueDates = generateRecurrenceDueDates({
      firstDueDate,
      frequency,
      occurrenceCount,
      endDate,
    });
    recurrenceId = crypto.randomUUID();
    recurrenceFrequency = frequency;
    recurrenceOccurrenceCount = occurrenceCount;
    recurrenceEndDate = endDate;
    plan = dueDates.map((dueDate, index) => ({
      dueDate,
      competenceMonth: competenceMonthOf(dueDate),
      amountCents: totalAmountCents,
      installmentNumber: 0,
      installmentTotal: 0,
      recurrenceIndex: index,
    }));
  } else {
    plan = [
      {
        dueDate: firstDueDate,
        competenceMonth: competenceMonthOf(firstDueDate),
        amountCents: totalAmountCents,
        installmentNumber: 0,
        installmentTotal: 0,
        recurrenceIndex: 0,
      },
    ];
  }

  // Destino na DRE escolhido por quem lança (NÃO INCLUIR / RATEAR /
  // INCLUIR EM). Sem destino (null) = regra antiga: DRE da loja da conta.
  const parsedDestination = await parseDreDestination(database, body, {
    companyId,
    companyName,
    financeItemId,
    competenceMonth: plan[0].competenceMonth,
    totalAmountCents: dreCustomized ? dreAmountCents : totalAmountCents,
    allStores,
    actorCompanyId: scopeActor.companyId,
  });
  if ("error" in parsedDestination) return reply({ error: parsedDestination.error }, parsedDestination.status);
  const destination = parsedDestination.destination;

  // Confere ANTES de escrever se algum slot loja+item+mês da série já é
  // ocupado por um lançamento manual da DRE — falha tudo, sem criar nada
  // pela metade (parcelamento/recorrência é tudo ou nada).
  const distinctMonths = [...new Set(plan.map((entry) => entry.competenceMonth))];
  const slotsToCheck = destination
    ? destination.shares.flatMap((share) => distinctMonths.map((month) => [share.companyId, destination.itemId, month]))
    : distinctMonths.map((month) => [companyId, financeItemId, month]);
  for (const [slotCompanyId, slotItemId, month] of slotsToCheck) {
    const conflict = await assertSlotAvailableForPayable(database, slotCompanyId, slotItemId, month);
    if (conflict) return reply({ error: conflict }, 409);
  }

  const statements: [string, unknown[]][] = [];
  const createdIds: string[] = [];
  const actorName = actor.displayName || "Administrador";

  // plan já está na ordem estável (1ª parcela / 1ª ocorrência primeiro) —
  // createdIds preserva essa ordem, então serve direto de entrada pra
  // computeDreAnchorAssignments (a 1ª linha criada é a âncora).
  for (let i = 0; i < plan.length; i += 1) {
    createdIds.push(crypto.randomUUID());
  }
  const dreAssignments = destination?.target === "none"
    ? computeDreAnchorAssignments(createdIds, false, 0)
    : dreCustomized
      ? computeDreAnchorAssignments(createdIds, dreIncluded, dreAmountCents)
      : null;

  plan.forEach((occurrence, index) => {
    const id = createdIds[index];
    statements.push([
      `INSERT INTO accounts_payable
        (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
         original_amount_cents, paid_amount_cents, dre_amount_cents, issue_date, competence_month, due_date, payment_method,
         invoice_number, order_reference, billing_code, notes, status,
         recurrence_id, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count, recurrence_end_date,
         installment_group_id, installment_number, installment_total, idempotency_key,
         created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, cost_center, cost_center_id,
         payer_name)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?10,?11,?12,?13,?14,?15,?16,?17,'open',
         ?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,CURRENT_TIMESTAMP,?27,?28,CURRENT_TIMESTAMP,?29,?30,?31)`,
      [
        id,
        companyId,
        companyName,
        description,
        supplierId,
        financeItemId,
        financeAccountId,
        occurrence.amountCents,
        dreAssignments ? dreAssignments.get(id) ?? null : null,
        issueDate,
        occurrence.competenceMonth,
        occurrence.dueDate,
        paymentMethod,
        invoiceNumber,
        orderReference,
        billingCode,
        notes,
        recurrenceId,
        recurrenceFrequency,
        occurrence.recurrenceIndex,
        recurrenceOccurrenceCount,
        recurrenceEndDate,
        installmentGroupId,
        occurrence.installmentNumber,
        occurrence.installmentTotal,
        // idempotencyKey único por linha: a chave enviada pelo cliente vale
        // pra 1ª ocorrência; as demais recebem uma derivada determinística,
        // então reenviar a mesma requisição nunca duplica a série inteira.
        occurrence.recurrenceIndex === 0 && occurrence.installmentNumber <= 1
          ? idempotencyKey
          : `${idempotencyKey}:${occurrence.recurrenceIndex}:${occurrence.installmentNumber}`,
        actor.id,
        actorName,
        costCenter,
        costCenterId || null,
        payerName,
      ],
    ]);
  });

  if (destination) {
    const destinationPlan = await planDreDestination(
      database,
      destination,
      plan.map((occurrence, index) => ({
        payableId: createdIds[index],
        month: occurrence.competenceMonth,
        amountCents: effectiveDreAmountCents(dreAssignments ? dreAssignments.get(createdIds[index]) ?? null : null, occurrence.amountCents),
      })),
    );
    statements.push(...destinationPlan.statements);
    statements.push(...recalcSlotsSql(destinationPlan.slots, { id: actor.id, name: actorName }));
  } else {
    for (const month of distinctMonths) {
      const entryId = crypto.randomUUID();
      for (const [sql, sqlValues] of recalcPayableEntrySql(entryId, companyId, financeItemId, month, actor.id, actorName)) {
        statements.push([sql, sqlValues]);
      }
    }
  }

  return { statements, ids: createdIds, dreWarning };
}

