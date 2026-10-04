import type { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR, type ScopeActor } from "../../../lib/access-scope";
import {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  competenceMonthOf,
  computeDreAnchorAssignments,
  effectiveDreAmountCents,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  isDreIncluded,
  prorateDreAmountByShare,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
} from "../../../lib/payables-recurrence";
import { assertFinanceAccountBelongsToCompany, assertSlotAvailableForPayable } from "../payables/shared";
import { MONTH_PATTERN, safeText, type JsonMap } from "../shared";
import { RATEIO_MODELS, type RateioModel } from "../../../lib/rateio-models";
import { computeRateioShares } from "./rateio";

export {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  MONTH_PATTERN,
  assertFinanceAccountBelongsToCompany,
  assertSlotAvailableForPayable,
  competenceMonthOf,
  computeDreAnchorAssignments,
  effectiveDreAmountCents,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  isDreIncluded,
  prorateDreAmountByShare,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
};

// 'single_store' (pertence só a uma loja) | 'rateio' (dividida entre lojas —
// modelo de cálculo implementado numa etapa seguinte) | 'no_rateio' (nunca
// entra em rateio).
export const RATEIO_TYPES = ["single_store", "rateio", "no_rateio"] as const;
export type RateioType = (typeof RATEIO_TYPES)[number];

export { RATEIO_MODELS, REVENUE_RATEIO_MODELS, type RateioModel } from "../../../lib/rateio-models";

export type ExpenseRow = {
  id: string;
  companyId: string;
  companyName: string;
  description: string;
  supplierId: string;
  financeItemId: string;
  financeAccountId: string;
  costCenter: string;
  costCenterId: string | null;
  originalAmountCents: number;
  issueDate: string;
  competenceMonth: string;
  dueDate: string;
  paymentMethod: string;
  invoiceNumber: string;
  orderReference: string;
  notes: string;
  kind: string;
  installmentTotal: number;
  recurrenceFrequency: string;
  recurrenceOccurrenceCount: number | null;
  recurrenceEndDate: string;
  rateioType: string;
  rateioModel: string;
  cardId: string;
  bankReconciliationId: string;
  createdAt: string;
  updatedAt: string;
};

export const EXPENSE_SELECT_COLUMNS = `id, company_id AS companyId, company_name AS companyName, description,
  supplier_id AS supplierId, finance_item_id AS financeItemId, finance_account_id AS financeAccountId,
  cost_center AS costCenter, cost_center_id AS costCenterId, original_amount_cents AS originalAmountCents,
  issue_date AS issueDate, competence_month AS competenceMonth, due_date AS dueDate,
  payment_method AS paymentMethod, invoice_number AS invoiceNumber, order_reference AS orderReference,
  notes, kind, installment_total AS installmentTotal,
  recurrence_frequency AS recurrenceFrequency, recurrence_occurrence_count AS recurrenceOccurrenceCount,
  recurrence_end_date AS recurrenceEndDate, rateio_type AS rateioType, rateio_model AS rateioModel,
  card_id AS cardId, bank_reconciliation_id AS bankReconciliationId,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function loadExpense(
  database: Awaited<ReturnType<typeof getD1>>,
  id: string,
): Promise<ExpenseRow | null> {
  return database
    .prepare(`SELECT ${EXPENSE_SELECT_COLUMNS} FROM expenses WHERE id=?1`)
    .bind(id)
    .first<ExpenseRow>();
}

/** Isolamento por loja: null se liberado, mensagem de erro (pra responder 403) caso contrário. */
export function assertExpenseAccess(scopeActor: ScopeActor, expense: ExpenseRow): string | null {
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (allStores) return null;
  if (!hasCompany(scopeActor.companyId)) return NO_COMPANY_ERROR;
  if (expense.companyId !== scopeActor.companyId) return "VOCÊ NÃO TEM ACESSO A ESSA DESPESA.";
  return null;
}

type ExpensePlanRow = {
  dueDate: string;
  competenceMonth: string;
  amountCents: number;
  installmentNumber: number;
  installmentTotal: number;
  recurrenceIndex: number;
};


type ExpenseReply = { reply: { payload: JsonMap; status: number } };
export type ExpensePlan = {
  expenseId: string;
  statements: [string, unknown[]][];
  payableIds: string[];
  dreWarning: string | null;
};

// Valida o corpo de uma Despesa e monta TODOS os comandos SQL (despesa,
// fatias do rateio, contas a pagar e recálculo da DRE) sem executar —
// usada pelo POST /api/finance/expenses e pelo lançamento em lote dos
// Cartões Corporativos (que junta várias despesas numa transação só).
// Respostas antecipadas (erro de validação ou idempotência) vêm em .reply.
export async function planExpense(
  database: Awaited<ReturnType<typeof getD1>>,
  actor: { id: string; displayName: string },
  scope: { allStores: boolean; companyId: string },
  body: JsonMap,
): Promise<ExpenseReply | ExpensePlan> {
  const reply = (payload: JsonMap, status = 200): ExpenseReply => ({ reply: { payload, status } });
  const allStores = scope.allStores;
  const scopeActor = { companyId: scope.companyId };
  const idempotencyKey = safeText(body.idempotencyKey, 120);
  if (!idempotencyKey) return reply({ error: "REQUISIÇÃO INVÁLIDA (SEM CHAVE DE IDEMPOTÊNCIA)." }, 400);

  const companyId = safeText(body.companyId, 80);
  const companyName = safeText(body.companyName, 160);
  if (!companyId) return reply({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
  if (!allStores && companyId !== scopeActor.companyId) {
    return reply({ error: "VOCÊ SÓ PODE CADASTRAR DESPESAS PARA A PRÓPRIA LOJA." }, 403);
  }

  const description = safeText(body.description, 200);
  if (description.length < 2) return reply({ error: "INFORME A DESCRIÇÃO DA DESPESA." }, 400);

  const financeItemId = safeText(body.financeItemId, 80);
  if (!financeItemId) return reply({ error: "SELECIONE A CATEGORIA/SUBCATEGORIA DA DESPESA." }, 400);

  const supplierId = safeText(body.supplierId, 80);
  const financeAccountId = safeText(body.financeAccountId, 80);
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
  const paymentMethod = safeText(body.paymentMethod, 40);
  const invoiceNumber = safeText(body.invoiceNumber, 60);
  const orderReference = safeText(body.orderReference, 60);
  const notes = safeText(body.notes, 2000);
  const cardId = safeText(body.cardId, 80);
  const bankReconciliationId = safeText(body.bankReconciliationId, 80);
  const issueDate = safeText(body.issueDate, 10);
  if (issueDate && !DATE_PATTERN.test(issueDate)) {
    return reply({ error: "DATA INVÁLIDA." }, 400);
  }

  const firstDueDate = safeText(body.dueDate, 10);
  if (!DATE_PATTERN.test(firstDueDate)) return reply({ error: "INFORME O VENCIMENTO." }, 400);

  const totalAmountCents = Number(body.originalAmountCents);
  if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
    return reply({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
  }

  // Decisão de "Incluir na DRE?" (opcional, nível da despesa inteira) —
  // quando dreIncluded não vem na requisição, todas as linhas de
  // accounts_payable geradas ficam com dre_amount_cents=NULL
  // (comportamento padrão). Numa despesa rateada entre lojas, o valor
  // customizado é distribuído proporcionalmente ao valor original de
  // cada loja (prorateDreAmountByShare) e a âncora fica na 1ª ocorrência
  // de CADA loja — a decisão nunca é rateada por parcela/mês, só por
  // loja (ver decisão de design no relatório da feature).
  const dreCustomized = body.dreIncluded !== undefined;
  const dreIncludedFlag = Boolean(body.dreIncluded);
  let dreAmountCentsTotal = 0;
  let dreWarning: string | null = null;
  if (dreCustomized) {
    dreAmountCentsTotal = Number(body.dreAmountCents);
    if (!Number.isFinite(dreAmountCentsTotal) || !Number.isInteger(dreAmountCentsTotal) || dreAmountCentsTotal < 0) {
      return reply({ error: "INFORME UM VALOR VÁLIDO (EM CENTAVOS, NÃO NEGATIVO) PARA A DRE." }, 400);
    }
    if (dreIncludedFlag && dreAmountCentsTotal > totalAmountCents) {
      dreWarning = "O VALOR INFORMADO PARA A DRE É MAIOR QUE O VALOR TOTAL DA DESPESA.";
    }
  }

  const rateioType = (safeText(body.rateioType, 20) || "single_store") as RateioType;
  if (!RATEIO_TYPES.includes(rateioType)) {
    return reply({ error: "CLASSIFICAÇÃO DE RATEIO INVÁLIDA." }, 400);
  }
  const rateioModel = safeText(body.rateioModel, 20) as RateioModel | "";
  if (rateioType === "rateio") {
    if (!rateioModel || !RATEIO_MODELS.includes(rateioModel)) {
      return reply({ error: "SELECIONE O MODELO DE RATEIO." }, 400);
    }
    // Rateio gera obrigações em outras lojas além da selecionada acima —
    // isso é esperado e faz parte da regra de negócio (o rateio existe
    // justamente pra dividir entre lojas). A trava de acesso é só
    // canManageFinance (ter permissão de Financeiro), verificada no topo
    // desta rota — o Financeiro é um módulo à parte cujo acesso já é
    // concedido pelo administrador principal a quem precisar, então não
    // faz sentido restringir rateio a quem "enxerga todas as lojas" em
    // outros módulos (ver [[estoque_modulo_despesas_rateio]]).
  }

  const kind = (safeText(body.kind, 20) || "single") as "single" | "installment" | "recurring";

  const item = await database
    .prepare("SELECT id FROM finance_items WHERE id=?1")
    .bind(financeItemId)
    .first<{ id: string }>();
  if (!item) return reply({ error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO." }, 400);

  // Numa despesa rateada, a mesma conta financeira vale pra todas as contas
  // a pagar geradas (uma por loja) — só uma conta GLOBAL (sem loja própria)
  // pode ser usada nesse caso, senão uma conta de uma loja específica
  // ficaria vinculada a pagáveis de outras lojas, violando a mesma regra
  // que assertFinanceAccountBelongsToCompany existe pra proteger.
  const accountError = await assertFinanceAccountBelongsToCompany(
    database,
    financeAccountId,
    rateioType === "rateio" ? "" : companyId,
  );
  if (accountError) {
    return reply(
      {
        error:
          rateioType === "rateio" && financeAccountId
            ? "EM DESPESA RATEADA, A CONTA FINANCEIRA PRECISA SER UMA CONTA GLOBAL (SEM LOJA PRÓPRIA) — ESCOLHA OUTRA CONTA OU DEIXE SEM CONTA."
            : accountError,
      },
      409,
    );
  }

  const existingByKey = await database
    .prepare("SELECT id FROM expenses WHERE idempotency_key=?1")
    .bind(idempotencyKey)
    .first<{ id: string }>();
  if (existingByKey) {
    return reply({ created: true, alreadyProcessed: true, id: existingByKey.id });
  }

  // dueDatesForPlan/recorrência/parcelamento são decididos uma vez só —
  // NÃO dependem do valor, então valem igual pra cada loja quando a
  // despesa é rateada (mesmas datas, valor de cada ocorrência
  // proporcional à fatia da loja). buildPlanForAmount() aplica um valor
  // (o total da despesa quando não é rateada, ou a fatia de cada loja
  // quando é) sobre essas mesmas datas.
  let dueDatesForPlan: string[];
  let recurrenceId: string | null = null;
  let installmentGroupId: string | null = null;
  let recurrenceFrequency = "";
  let recurrenceOccurrenceCount: number | null = null;
  let recurrenceEndDate = "";
  let installmentTotalPlan = 0;
  let singleCompetenceMonth = "";

  if (kind === "installment") {
    const installmentTotal = Math.trunc(Number(body.installmentTotal));
    if (!Number.isInteger(installmentTotal) || installmentTotal < 2 || installmentTotal > 360) {
      return reply({ error: "INFORME A QUANTIDADE DE PARCELAS (MÍNIMO 2)." }, 400);
    }
    installmentTotalPlan = installmentTotal;
    dueDatesForPlan = generateInstallmentDueDates(firstDueDate, installmentTotal);
    installmentGroupId = crypto.randomUUID();
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
    dueDatesForPlan = generateRecurrenceDueDates({ firstDueDate, frequency, occurrenceCount, endDate });
    recurrenceId = crypto.randomUUID();
    recurrenceFrequency = frequency;
    recurrenceOccurrenceCount = occurrenceCount;
    recurrenceEndDate = endDate;
  } else {
    // Só a despesa avulsa aceita competência explícita (a mesma
    // possibilidade que Contas a Pagar já dá na edição) — parcelamento e
    // recorrência sempre derivam a competência de cada vencimento gerado,
    // pra cada ocorrência cair no mês certo da DRE.
    const competenceOverride = safeText(body.competenceMonth, 7);
    singleCompetenceMonth = MONTH_PATTERN.test(competenceOverride) ? competenceOverride : competenceMonthOf(firstDueDate);
    dueDatesForPlan = [firstDueDate];
  }

  function buildPlanForAmount(amountCents: number): ExpensePlanRow[] {
    if (kind === "installment") {
      const amounts = splitIntoInstallments(amountCents, installmentTotalPlan);
      return dueDatesForPlan.map((dueDate, index) => ({
        dueDate,
        competenceMonth: competenceMonthOf(dueDate),
        amountCents: amounts[index],
        installmentNumber: index + 1,
        installmentTotal: installmentTotalPlan,
        recurrenceIndex: 0,
      }));
    }
    if (kind === "recurring") {
      return dueDatesForPlan.map((dueDate, index) => ({
        dueDate,
        competenceMonth: competenceMonthOf(dueDate),
        amountCents,
        installmentNumber: 0,
        installmentTotal: 0,
        recurrenceIndex: index,
      }));
    }
    return [
      {
        dueDate: firstDueDate,
        competenceMonth: singleCompetenceMonth,
        amountCents,
        installmentNumber: 0,
        installmentTotal: 0,
        recurrenceIndex: 0,
      },
    ];
  }

  const primaryCompetenceMonth =
    kind === "single" ? singleCompetenceMonth : competenceMonthOf(dueDatesForPlan[0]);

  type ExpenseShare = { companyId: string; companyName: string; amountCents: number; percentBasisPoints: number };
  let shares: ExpenseShare[];
  if (rateioType === "rateio") {
    const customShares = Array.isArray(body.rateioShares)
      ? (body.rateioShares as JsonMap[]).map((entry) => ({
          companyId: safeText(entry.companyId, 80),
          percentBasisPoints: Math.round(Number(entry.percentBasisPoints)),
        }))
      : undefined;
    const rateioResult = await computeRateioShares(database, {
      model: rateioModel as RateioModel,
      competenceMonth: primaryCompetenceMonth,
      totalAmountCents,
      customShares,
    });
    if ("error" in rateioResult) return reply({ error: rateioResult.error }, 409);
    shares = rateioResult.shares;
  } else {
    shares = [{ companyId, companyName, amountCents: totalAmountCents, percentBasisPoints: 0 }];
  }

  const sharePlans = shares.map((share) => ({ share, plan: buildPlanForAmount(share.amountCents) }));

  // Mapa (não Set de string) pra nunca precisar re-parsear um delimitador
  // — companyId/month ficam como valores de verdade, não codificados
  // numa string só.
  const distinctSlots = new Map<string, { companyId: string; month: string }>();
  for (const { share, plan } of sharePlans) {
    for (const occurrence of plan) {
      distinctSlots.set(share.companyId + "::" + occurrence.competenceMonth, {
        companyId: share.companyId,
        month: occurrence.competenceMonth,
      });
    }
  }
  const conflicts = await Promise.all(
    [...distinctSlots.values()].map((slot) =>
      assertSlotAvailableForPayable(database, slot.companyId, financeItemId, slot.month),
    ),
  );
  const firstConflict = conflicts.find((conflict) => conflict);
  if (firstConflict) return reply({ error: firstConflict }, 409);

  const expenseId = crypto.randomUUID();
  const actorName = actor.displayName || "Administrador";
  const statements: [string, unknown[]][] = [];

  statements.push([
    `INSERT INTO expenses
      (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
       cost_center, original_amount_cents, issue_date, competence_month, due_date, payment_method,
       invoice_number, order_reference, notes, kind, installment_total,
       recurrence_frequency, recurrence_occurrence_count, recurrence_end_date,
       rateio_type, rateio_model, card_id, bank_reconciliation_id, idempotency_key,
       created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, cost_center_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,CURRENT_TIMESTAMP,?27,?28,CURRENT_TIMESTAMP,?29)`,
    [
      expenseId,
      companyId,
      companyName,
      description,
      supplierId,
      financeItemId,
      financeAccountId,
      costCenter,
      totalAmountCents,
      issueDate,
      primaryCompetenceMonth,
      firstDueDate,
      paymentMethod,
      invoiceNumber,
      orderReference,
      notes,
      kind,
      installmentGroupId ? installmentTotalPlan : 0,
      recurrenceFrequency,
      recurrenceOccurrenceCount,
      recurrenceEndDate,
      rateioType,
      rateioModel || "",
      cardId,
      bankReconciliationId,
      idempotencyKey,
      actor.id,
      actorName,
      costCenterId || null,
    ],
  ]);

  // Prorateia o valor de DRE customizado (nível despesa) entre as lojas
  // do rateio, proporcional ao valor original de cada uma — despesa
  // single-store é só uma "fatia" de 100%, então cai no mesmo código.
  const shareDreTotals = dreCustomized
    ? prorateDreAmountByShare(
        shares.map((share) => ({ key: share.companyId, originalAmountCents: share.amountCents })),
        dreIncludedFlag ? dreAmountCentsTotal : 0,
      )
    : null;

  const createdPayableIds: string[] = [];
  for (let shareIndex = 0; shareIndex < sharePlans.length; shareIndex += 1) {
    const { share, plan } = sharePlans[shareIndex];
    // IDs pré-gerados na ordem do plano (1ª ocorrência primeiro) pra
    // poder calcular a âncora ANTES de montar os INSERTs.
    const planPayableIds = plan.map(() => crypto.randomUUID());
    const shareDreAssignments = dreCustomized
      ? computeDreAnchorAssignments(planPayableIds, true, shareDreTotals?.get(share.companyId) ?? 0)
      : null;
    if (rateioType === "rateio") {
      statements.push([
        `INSERT INTO expense_rateio_shares (id, expense_id, company_id, company_name, percent_basis_points, amount_cents, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,CURRENT_TIMESTAMP)`,
        [
          crypto.randomUUID(),
          expenseId,
          share.companyId,
          share.companyName,
          share.percentBasisPoints,
          share.amountCents,
        ],
      ]);
    }
    plan.forEach((occurrence, occurrenceIndex) => {
      const payableId = planPayableIds[occurrenceIndex];
      createdPayableIds.push(payableId);
      statements.push([
        `INSERT INTO accounts_payable
          (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
           cost_center, original_amount_cents, paid_amount_cents, dre_amount_cents, issue_date, competence_month, due_date, payment_method,
           invoice_number, order_reference, billing_code, notes, status,
           recurrence_id, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count, recurrence_end_date,
           installment_group_id, installment_number, installment_total, expense_id, idempotency_key,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at, cost_center_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10,?11,?12,?13,?14,?15,?16,'',?17,'open',
           ?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,CURRENT_TIMESTAMP,?28,?29,CURRENT_TIMESTAMP,?30)`,
        [
          payableId,
          share.companyId,
          share.companyName,
          description,
          supplierId,
          financeItemId,
          financeAccountId,
          costCenter,
          occurrence.amountCents,
          shareDreAssignments ? shareDreAssignments.get(payableId) ?? null : null,
          issueDate,
          occurrence.competenceMonth,
          occurrence.dueDate,
          paymentMethod,
          invoiceNumber,
          orderReference,
          notes,
          recurrenceId,
          recurrenceFrequency,
          occurrence.recurrenceIndex,
          recurrenceOccurrenceCount,
          recurrenceEndDate,
          installmentGroupId,
          occurrence.installmentNumber,
          occurrence.installmentTotal,
          expenseId,
          // idempotencyKey própria por linha (loja + ocorrência) — não
          // colide com contas criadas direto em Contas a Pagar nem entre
          // lojas diferentes do mesmo rateio.
          `expense:${idempotencyKey}:${shareIndex}:${occurrence.recurrenceIndex}:${occurrence.installmentNumber}`,
          actor.id,
          actorName,
          costCenterId || null,
        ],
      ]);
    });
  }

  for (const slot of distinctSlots.values()) {
    const entryId = crypto.randomUUID();
    for (const [sql, sqlValues] of recalcPayableEntrySql(entryId, slot.companyId, financeItemId, slot.month, actor.id, actorName)) {
      statements.push([sql, sqlValues]);
    }
  }


  return { expenseId, statements, payableIds: createdPayableIds, dreWarning };
}
