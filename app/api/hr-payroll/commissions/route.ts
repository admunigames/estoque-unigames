import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  competencesForInstallments,
  normalizeInstallmentTotal,
} from "../../../lib/commission-installments";
import {
  COMMISSION_KINDS,
  MONTH_PATTERN,
  actorName,
  canManagePayroll,
  centsValue,
  commissionNetCents,
  loadCommissionRuleText,
  identity,
  isOneOf,
  jsonResponse,
  loadEmployee,
  safeText,
  sameOrigin,
  type CommissionKind,
  type Database,
  type JsonMap,
} from "../shared";

// Comissionamento — um cabeçalho por funcionário/mês, com as linhas
// itemizadas que o sustentam (bônus, premiações, descontos e ajustes).
//
// Os quatro totais do cabeçalho são desnormalizados a partir das linhas e
// recalculados no MESMO batch em que as linhas são regravadas, então nunca
// ficam fora de sincronia. amount_cents da linha é sempre magnitude
// positiva, exceto em 'ajuste', que preserva o sinal informado; o sinal do
// desconto entra só na fórmula do valor final:
//   comissão + bônus + premiações - descontos + ajustes
//
// Parcelamento de desconto (item 2): uma linha de desconto pode ser
// parcelada em N ocorrências. A linha da competência-âncora tem
// installment_number = 1 (é a única enviada pelo cliente e a única
// editável); as ocorrências 2..N são geradas neste POST nas competências
// seguintes, com o VALOR CHEIO repetido, e reconciliadas sempre que a
// âncora é salva de novo. O cabeçalho de cada competência futura é criado
// se ainda não existir.

type CommissionRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  month: string;
  commissionCents: number;
  bonusesCents: number;
  premiumsCents: number;
  discountsCents: number;
  adjustmentsCents: number;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

type ItemRow = {
  id: string;
  commissionId: string;
  presetId: string;
  label: string;
  kind: string;
  amountCents: number;
  installmentGroupId: string;
  installmentNumber: number;
  installmentTotal: number;
  createdBy: string;
  createdAt: string;
};

type ParsedItem = {
  presetId: string;
  label: string;
  kind: CommissionKind;
  amountCents: number;
  installmentGroupId: string;
  installmentTotal: number;
};

const COMMISSION_COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, month,
  commission_cents AS commissionCents, bonuses_cents AS bonusesCents,
  premiums_cents AS premiumsCents, discounts_cents AS discountsCents,
  adjustments_cents AS adjustmentsCents, notes, created_by AS createdBy,
  created_by_name AS createdByName, created_at AS createdAt, updated_by AS updatedBy,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

const ITEM_COLUMNS = `id, commission_id AS commissionId, preset_id AS presetId, label, kind,
  amount_cents AS amountCents, installment_group_id AS installmentGroupId,
  installment_number AS installmentNumber, installment_total AS installmentTotal,
  created_by AS createdBy, created_at AS createdAt`;

function parseItems(value: unknown): { items: ParsedItem[]; error: string } {
  if (value === undefined || value === null) return { items: [], error: "" };
  if (!Array.isArray(value)) return { items: [], error: "LISTA DE LANÇAMENTOS INVÁLIDA." };
  if (value.length > 100) return { items: [], error: "NO MÁXIMO 100 LANÇAMENTOS POR COMISSÃO." };
  const items: ParsedItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { items: [], error: "LANÇAMENTO INVÁLIDO." };
    const entry = raw as JsonMap;
    const kind = safeText(entry.kind, 20);
    if (!isOneOf(COMMISSION_KINDS, kind)) {
      return { items: [], error: "SELECIONE UM TIPO VÁLIDO PARA CADA LANÇAMENTO." };
    }
    const label = safeText(entry.label, 120);
    if (!label) return { items: [], error: "INFORME A DESCRIÇÃO DE CADA LANÇAMENTO." };
    const amount = centsValue(entry.amountCents);
    if (!Number.isFinite(amount)) {
      return { items: [], error: "INFORME UM VALOR VÁLIDO EM CADA LANÇAMENTO." };
    }
    // Só o ajuste pode ser negativo — bônus/premiação/desconto são sempre
    // magnitudes positivas (o sinal do desconto vem da fórmula).
    if (kind !== "ajuste" && amount <= 0) {
      return { items: [], error: "INFORME UM VALOR MAIOR QUE ZERO EM CADA LANÇAMENTO." };
    }
    if (kind === "ajuste" && amount === 0) {
      return { items: [], error: "INFORME UM VALOR DIFERENTE DE ZERO NO AJUSTE." };
    }
    const installmentTotal = normalizeInstallmentTotal(kind, entry.installmentTotal);
    const providedGroupId = safeText(entry.installmentGroupId, 80);
    items.push({
      presetId: safeText(entry.presetId, 80),
      label,
      kind,
      amountCents: kind === "ajuste" ? amount : Math.abs(amount),
      // Grupo preservado na edição, ou novo quando a série passa a existir.
      installmentGroupId:
        installmentTotal >= 2 ? providedGroupId || crypto.randomUUID() : "",
      installmentTotal,
    });
  }
  return { items, error: "" };
}

/**
 * Recalcula os quatro totais desnormalizados de um cabeçalho a partir de
 * TODAS as linhas dele (inclusive as parcelas geradas de descontos). Roda
 * uma vez por cabeçalho tocado — âncora e competências futuras.
 */
async function recalcCommissionTotals(
  database: Database,
  commissionId: string,
  actorId: string,
  actorDisplayName: string,
): Promise<void> {
  const result = await database
    .prepare(
      `SELECT kind, COALESCE(SUM(amount_cents), 0) AS total
       FROM hr_commission_items WHERE commission_id=?1 GROUP BY kind`,
    )
    .bind(commissionId)
    .all<{ kind: string; total: number }>();
  const totals = { bonusesCents: 0, premiumsCents: 0, discountsCents: 0, adjustmentsCents: 0 };
  for (const row of result.results ?? []) {
    if (row.kind === "bonus") totals.bonusesCents = Number(row.total);
    else if (row.kind === "premiacao") totals.premiumsCents = Number(row.total);
    else if (row.kind === "desconto") totals.discountsCents = Number(row.total);
    else if (row.kind === "ajuste") totals.adjustmentsCents = Number(row.total);
  }
  await database
    .prepare(
      `UPDATE hr_commissions
       SET bonuses_cents=?1, premiums_cents=?2, discounts_cents=?3, adjustments_cents=?4,
           updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
       WHERE id=?7`,
    )
    .bind(
      totals.bonusesCents,
      totals.premiumsCents,
      totals.discountsCents,
      totals.adjustmentsCents,
      actorId,
      actorDisplayName,
      commissionId,
    )
    .run();
}

/**
 * Garante que existe o cabeçalho de comissão do funcionário na competência
 * informada e devolve o id. Cria zerado quando ainda não existe (uma
 * competência futura que só recebe parcela de desconto).
 */
async function ensureCommissionHeader(
  database: Database,
  employee: { id: string; fullName: string; companyId: string; companyName: string },
  month: string,
  actorId: string,
  actorDisplayName: string,
): Promise<string> {
  const existing = await database
    .prepare("SELECT id FROM hr_commissions WHERE employee_id=?1 AND month=?2 LIMIT 1")
    .bind(employee.id, month)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO hr_commissions
        (id, employee_id, employee_name, company_id, company_name, month, commission_cents,
         bonuses_cents, premiums_cents, discounts_cents, adjustments_cents, notes,
         created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, 0, 0, '', ?7, ?8,
               CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)`,
    )
    .bind(id, employee.id, employee.fullName, employee.companyId, employee.companyName, month, actorId, actorDisplayName)
    .run();
  return id;
}

/**
 * Apaga as ocorrências futuras (installment_number >= 2) de um grupo de
 * parcelamento e devolve os ids dos cabeçalhos afetados, para recálculo.
 */
async function deleteFutureInstallments(
  database: Database,
  groupId: string,
): Promise<string[]> {
  if (!groupId) return [];
  const affected = await database
    .prepare(
      `SELECT DISTINCT commission_id AS commissionId FROM hr_commission_items
       WHERE installment_group_id=?1 AND installment_number >= 2`,
    )
    .bind(groupId)
    .all<{ commissionId: string }>();
  await database
    .prepare(
      "DELETE FROM hr_commission_items WHERE installment_group_id=?1 AND installment_number >= 2",
    )
    .bind(groupId)
    .run();
  return (affected.results ?? []).map((row) => row.commissionId);
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMISSIONAMENTO." }, 403);
  }

  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  const companyId = safeText(url.searchParams.get("companyId"), 80);

  try {
    const database = await getD1();
    const companyCondition = companyId ? "AND company_id=?2" : "";
    const params = companyId ? [month, companyId] : [month];
    const commissionsResult = await database
      .prepare(
        `SELECT ${COMMISSION_COLUMNS} FROM hr_commissions
         WHERE month=?1 ${companyCondition} ORDER BY employee_name ASC`,
      )
      .bind(...params)
      .all<CommissionRow>();
    const commissions = commissionsResult.results ?? [];

    const itemsByCommission = new Map<string, ItemRow[]>();
    if (commissions.length) {
      const placeholders = commissions.map((_row, index) => `?${index + 1}`).join(",");
      const itemsResult = await database
        .prepare(
          `SELECT ${ITEM_COLUMNS} FROM hr_commission_items
           WHERE commission_id IN (${placeholders}) ORDER BY created_at ASC`,
        )
        .bind(...commissions.map((row) => row.id))
        .all<ItemRow>();
      for (const item of itemsResult.results ?? []) {
        const list = itemsByCommission.get(item.commissionId) ?? [];
        list.push(item);
        itemsByCommission.set(item.commissionId, list);
      }
    }

    const rows = commissions.map((row) => ({
      ...row,
      netCents: commissionNetCents(row),
      items: itemsByCommission.get(row.id) ?? [],
    }));
    const commissionRuleText = await loadCommissionRuleText(database);
    return jsonResponse({
      month,
      companyId,
      commissionRuleText,
      commissions: rows,
      totalNetCents: rows.reduce((sum, row) => sum + row.netCents, 0),
    });
  } catch (error) {
    console.error("Não foi possível carregar o comissionamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O COMISSIONAMENTO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR COMISSÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const month = safeText(body.month, 7);
    const notes = safeText(body.notes, 500);
    const commissionCents = centsValue(body.commissionCents ?? 0);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }
    if (!Number.isFinite(commissionCents) || commissionCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR DE COMISSÃO VÁLIDO." }, 400);
    }
    const { items, error: itemsError } = parseItems(body.items);
    if (itemsError) return jsonResponse({ error: itemsError }, 400);

    const database = await getD1();
    const employee = await loadEmployee(database, employeeId);
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

    const existing = await database
      .prepare("SELECT id FROM hr_commissions WHERE employee_id=?1 AND month=?2 LIMIT 1")
      .bind(employeeId, month)
      .first<{ id: string }>();
    if (existing && editId && existing.id !== editId) {
      return jsonResponse({ error: "JÁ EXISTE COMISSÃO DESSE FUNCIONÁRIO NESSA COMPETÊNCIA." }, 409);
    }
    const commissionId = editId || existing?.id || crypto.randomUUID();
    const isUpdate = Boolean(editId || existing);
    if (editId && !existing) {
      const byId = await database
        .prepare("SELECT id FROM hr_commissions WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string }>();
      if (!byId) return jsonResponse({ error: "COMISSÃO NÃO ENCONTRADA." }, 404);
    }

    // Grupos de parcelamento que já existiam nesta competência-âncora, para
    // detectar quais séries foram removidas/alteradas na edição.
    const previousAnchors = isUpdate
      ? await database
          .prepare(
            `SELECT installment_group_id AS groupId FROM hr_commission_items
             WHERE commission_id=?1 AND installment_number = 1 AND installment_group_id <> ''`,
          )
          .bind(commissionId)
          .all<{ groupId: string }>()
      : { results: [] as { groupId: string }[] };
    const previousGroupIds = new Set(
      (previousAnchors.results ?? []).map((row) => row.groupId),
    );

    const header = isUpdate
      ? database
          .prepare(
            `UPDATE hr_commissions
             SET employee_id=?1, employee_name=?2, company_id=?3, company_name=?4, month=?5,
                 commission_cents=?6, notes=?7, updated_by=?8, updated_by_name=?9,
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=?10`,
          )
          .bind(
            employeeId,
            employee.fullName,
            employee.companyId,
            employee.companyName,
            month,
            commissionCents,
            notes,
            actor.id,
            actorName(actor),
            commissionId,
          )
      : database
          .prepare(
            `INSERT INTO hr_commissions
              (id, employee_id, employee_name, company_id, company_name, month, commission_cents,
               bonuses_cents, premiums_cents, discounts_cents, adjustments_cents, notes,
               created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, 0, ?8, ?9, ?10,
                     CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)`,
          )
          .bind(
            commissionId,
            employeeId,
            employee.fullName,
            employee.companyId,
            employee.companyName,
            month,
            commissionCents,
            notes,
            actor.id,
            actorName(actor),
          );

    // Cabeçalho + troca das linhas NÃO geradas (installment_number < 2) da
    // competência-âncora. As parcelas geradas de descontos (número >= 2)
    // que porventura existam aqui são preservadas — quem as controla é a
    // âncora da série, não esta tela.
    await database.batch([
      header,
      database
        .prepare(
          "DELETE FROM hr_commission_items WHERE commission_id=?1 AND installment_number < 2",
        )
        .bind(commissionId),
      ...items.map((item) =>
        database
          .prepare(
            `INSERT INTO hr_commission_items
              (id, commission_id, preset_id, label, kind, amount_cents, installment_group_id,
               installment_number, installment_total, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP)`,
          )
          .bind(
            crypto.randomUUID(),
            commissionId,
            item.presetId,
            item.label,
            item.kind,
            item.amountCents,
            item.installmentGroupId,
            item.installmentTotal >= 2 ? 1 : 0,
            item.installmentTotal >= 2 ? item.installmentTotal : 0,
            actor.id,
          ),
      ),
    ]);

    // ---- Reconciliação das séries de desconto parcelado ----
    const touchedHeaders = new Set<string>();
    const activeSeries = items.filter((item) => item.installmentTotal >= 2);
    const activeGroupIds = new Set(activeSeries.map((item) => item.installmentGroupId));

    // Séries removidas na edição: some com todas as ocorrências futuras.
    for (const groupId of previousGroupIds) {
      if (!activeGroupIds.has(groupId)) {
        for (const id of await deleteFutureInstallments(database, groupId)) {
          touchedHeaders.add(id);
        }
      }
    }

    // Séries ativas: regenera as ocorrências 2..N do zero, com o valor
    // cheio repetido nas competências seguintes.
    for (const series of activeSeries) {
      for (const id of await deleteFutureInstallments(database, series.installmentGroupId)) {
        touchedHeaders.add(id);
      }
      const competences = competencesForInstallments(month, series.installmentTotal);
      for (let index = 1; index < competences.length; index += 1) {
        const targetMonth = competences[index];
        const targetId = await ensureCommissionHeader(
          database,
          employee,
          targetMonth,
          actor.id,
          actorName(actor),
        );
        await database
          .prepare(
            `INSERT INTO hr_commission_items
              (id, commission_id, preset_id, label, kind, amount_cents, installment_group_id,
               installment_number, installment_total, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, 'desconto', ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)`,
          )
          .bind(
            crypto.randomUUID(),
            targetId,
            series.presetId,
            series.label,
            series.amountCents,
            series.installmentGroupId,
            index + 1,
            series.installmentTotal,
            actor.id,
          )
          .run();
        touchedHeaders.add(targetId);
      }
    }

    // A âncora sempre recalcula; as competências futuras tocadas também.
    touchedHeaders.delete(commissionId);
    await recalcCommissionTotals(database, commissionId, actor.id, actorName(actor));
    for (const id of touchedHeaders) {
      await recalcCommissionTotals(database, id, actor.id, actorName(actor));
    }

    return jsonResponse(
      isUpdate ? { updated: true, id: commissionId } : { created: true, id: commissionId },
      isUpdate ? 200 : 201,
    );
  } catch (error) {
    console.error("Não foi possível salvar a comissão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A COMISSÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR COMISSÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "COMISSÃO INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    // Séries de desconto parcelado ancoradas nesta comissão: some com as
    // ocorrências futuras antes de apagar o cabeçalho.
    const anchors = await database
      .prepare(
        `SELECT installment_group_id AS groupId FROM hr_commission_items
         WHERE commission_id=?1 AND installment_number = 1 AND installment_group_id <> ''`,
      )
      .bind(id)
      .all<{ groupId: string }>();
    const touchedHeaders = new Set<string>();
    for (const row of anchors.results ?? []) {
      for (const headerId of await deleteFutureInstallments(database, row.groupId)) {
        touchedHeaders.add(headerId);
      }
    }

    // Sem FK no banco (convenção do projeto): a cascata é feita aqui.
    await database.batch([
      database.prepare("DELETE FROM hr_commission_items WHERE commission_id=?1").bind(id),
      database.prepare("DELETE FROM hr_commissions WHERE id=?1").bind(id),
    ]);

    touchedHeaders.delete(id);
    for (const headerId of touchedHeaders) {
      await recalcCommissionTotals(database, headerId, actor.id, actorName(actor));
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a comissão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A COMISSÃO." }, 500);
  }
}
