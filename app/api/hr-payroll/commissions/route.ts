import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  COMMISSION_KINDS,
  MONTH_PATTERN,
  actorName,
  canManagePayroll,
  centsValue,
  commissionNetCents,
  identity,
  isOneOf,
  jsonResponse,
  loadEmployee,
  safeText,
  sameOrigin,
  type CommissionKind,
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
  createdBy: string;
  createdAt: string;
};

type ParsedItem = {
  presetId: string;
  label: string;
  kind: CommissionKind;
  amountCents: number;
};

const COMMISSION_COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, month,
  commission_cents AS commissionCents, bonuses_cents AS bonusesCents,
  premiums_cents AS premiumsCents, discounts_cents AS discountsCents,
  adjustments_cents AS adjustmentsCents, notes, created_by AS createdBy,
  created_by_name AS createdByName, created_at AS createdAt, updated_by AS updatedBy,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

const ITEM_COLUMNS = `id, commission_id AS commissionId, preset_id AS presetId, label, kind,
  amount_cents AS amountCents, created_by AS createdBy, created_at AS createdAt`;

function totalsFromItems(items: ParsedItem[]) {
  const totals = { bonusesCents: 0, premiumsCents: 0, discountsCents: 0, adjustmentsCents: 0 };
  for (const item of items) {
    if (item.kind === "bonus") totals.bonusesCents += item.amountCents;
    else if (item.kind === "premiacao") totals.premiumsCents += item.amountCents;
    else if (item.kind === "desconto") totals.discountsCents += item.amountCents;
    else totals.adjustmentsCents += item.amountCents;
  }
  return totals;
}

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
    items.push({
      presetId: safeText(entry.presetId, 80),
      label,
      kind,
      amountCents: kind === "ajuste" ? amount : Math.abs(amount),
    });
  }
  return { items, error: "" };
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
    return jsonResponse({
      month,
      companyId,
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

    const totals = totalsFromItems(items);
    const header = isUpdate
      ? database
          .prepare(
            `UPDATE hr_commissions
             SET employee_id=?1, employee_name=?2, company_id=?3, company_name=?4, month=?5,
                 commission_cents=?6, bonuses_cents=?7, premiums_cents=?8, discounts_cents=?9,
                 adjustments_cents=?10, notes=?11, updated_by=?12, updated_by_name=?13,
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=?14`,
          )
          .bind(
            employeeId,
            employee.fullName,
            employee.companyId,
            employee.companyName,
            month,
            commissionCents,
            totals.bonusesCents,
            totals.premiumsCents,
            totals.discountsCents,
            totals.adjustmentsCents,
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
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                     CURRENT_TIMESTAMP, ?13, ?14, CURRENT_TIMESTAMP)`,
          )
          .bind(
            commissionId,
            employeeId,
            employee.fullName,
            employee.companyId,
            employee.companyName,
            month,
            commissionCents,
            totals.bonusesCents,
            totals.premiumsCents,
            totals.discountsCents,
            totals.adjustmentsCents,
            notes,
            actor.id,
            actorName(actor),
          );

    // Cabeçalho + troca completa das linhas no mesmo batch: os totais
    // desnormalizados e as linhas que os originam nunca divergem.
    await database.batch([
      header,
      database.prepare("DELETE FROM hr_commission_items WHERE commission_id=?1").bind(commissionId),
      ...items.map((item) =>
        database
          .prepare(
            `INSERT INTO hr_commission_items
              (id, commission_id, preset_id, label, kind, amount_cents, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)`,
          )
          .bind(
            crypto.randomUUID(),
            commissionId,
            item.presetId,
            item.label,
            item.kind,
            item.amountCents,
            actor.id,
          ),
      ),
    ]);

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
    // Sem FK no banco (convenção do projeto): a cascata é feita aqui.
    await database.batch([
      database.prepare("DELETE FROM hr_commission_items WHERE commission_id=?1").bind(id),
      database.prepare("DELETE FROM hr_commissions WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a comissão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A COMISSÃO." }, 500);
  }
}
