import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import { deriveMallDeclaration } from "../../../lib/mall-declarations";

// Declaração de Shopping (Financeiro — Fase 8). Um registro por
// loja/shopping/competência, com histórico mensal, comparativo e alerta de
// aluguel percentual (ver app/lib/mall-declarations.ts).

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, unknown>;

const SELECT_COLUMNS = `id, mall_name AS mallName, company_id AS companyId, company_name AS companyName,
  competence_month AS competenceMonth, real_revenue_cents AS realRevenueCents,
  avg_declared_cents AS avgDeclaredCents, suggested_declared_cents AS suggestedDeclaredCents,
  declared_cents AS declaredCents, declaration_date AS declarationDate,
  contract_percent_bps AS contractPercentBps, minimum_rent_cents AS minimumRentCents,
  percentage_rent_cents AS percentageRentCents, percentage_rent_paid AS percentageRentPaid,
  amount_paid_cents AS amountPaidCents, notes,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

function withDerived(row: Row) {
  const derived = deriveMallDeclaration({
    realRevenueCents: Number(row.realRevenueCents) || 0,
    declaredCents: Number(row.declaredCents) || 0,
    avgDeclaredCents: Number(row.avgDeclaredCents) || 0,
    contractPercentBps: Number(row.contractPercentBps) || 0,
    minimumRentCents: Number(row.minimumRentCents) || 0,
  });
  return { ...row, derived };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const params = new URL(request.url).searchParams;
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (fragment: string, value: unknown) => {
    values.push(value);
    conditions.push(fragment.replace("?", `?${values.length}`));
  };
  const companyId = safeText(params.get("companyId"), 80);
  if (companyId) add("company_id = ?", companyId);
  const mallName = safeText(params.get("mallName"), 160);
  if (mallName) add("mall_name = ?", mallName);
  const monthFrom = safeText(params.get("monthFrom"), 7);
  if (MONTH_PATTERN.test(monthFrom)) add("competence_month >= ?", monthFrom);
  const monthTo = safeText(params.get("monthTo"), 7);
  if (MONTH_PATTERN.test(monthTo)) add("competence_month <= ?", monthTo);
  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM finance_mall_declarations
         ${whereSql} ORDER BY competence_month DESC, mall_name ASC, company_name ASC LIMIT 1000`,
      )
      .bind(...values)
      .all<Row>();
    const malls = await database
      .prepare("SELECT DISTINCT mall_name AS mallName FROM finance_mall_declarations ORDER BY mall_name ASC")
      .all<{ mallName: string }>();
    return jsonResponse({
      rows: (rows.results ?? []).map(withDerived),
      malls: (malls.results ?? []).map((m) => m.mallName).filter(Boolean),
    });
  } catch (error) {
    console.error("Não foi possível carregar as declarações de shopping.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS DECLARAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DECLARAÇÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const mallName = safeText(body.mallName, 160);
    if (mallName.length < 2) return jsonResponse({ error: "INFORME O SHOPPING." }, 400);
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    const competenceMonth = safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) return jsonResponse({ error: "INFORME A COMPETÊNCIA (AAAA-MM)." }, 400);
    const declarationDate = safeText(body.declarationDate, 10);
    if (declarationDate && !DATE_PATTERN.test(declarationDate)) {
      return jsonResponse({ error: "DATA DA DECLARAÇÃO INVÁLIDA." }, 400);
    }

    const intField = (value: unknown, label: string, allowZero = true): number | { error: string } => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
        return { error: `INFORME UM VALOR VÁLIDO EM CENTAVOS PARA ${label}.` };
      }
      return n;
    };

    const realRevenueCents = intField(body.realRevenueCents, "O FATURAMENTO REAL");
    if (typeof realRevenueCents !== "number") return jsonResponse(realRevenueCents, 400);
    const avgDeclaredCents = intField(body.avgDeclaredCents, "A MÉDIA DECLARADA");
    if (typeof avgDeclaredCents !== "number") return jsonResponse(avgDeclaredCents, 400);
    const suggestedDeclaredCents = intField(body.suggestedDeclaredCents, "O VALOR SUGERIDO");
    if (typeof suggestedDeclaredCents !== "number") return jsonResponse(suggestedDeclaredCents, 400);
    const declaredCents = intField(body.declaredCents, "O VALOR DECLARADO");
    if (typeof declaredCents !== "number") return jsonResponse(declaredCents, 400);
    const minimumRentCents = intField(body.minimumRentCents, "O ALUGUEL MÍNIMO");
    if (typeof minimumRentCents !== "number") return jsonResponse(minimumRentCents, 400);
    const percentageRentCents = intField(body.percentageRentCents, "O ALUGUEL PERCENTUAL");
    if (typeof percentageRentCents !== "number") return jsonResponse(percentageRentCents, 400);
    const amountPaidCents = intField(body.amountPaidCents, "O VALOR PAGO");
    if (typeof amountPaidCents !== "number") return jsonResponse(amountPaidCents, 400);

    const contractPercentBps = Number(body.contractPercentBps);
    if (!Number.isInteger(contractPercentBps) || contractPercentBps < 0 || contractPercentBps > 100000) {
      return jsonResponse({ error: "INFORME O PERCENTUAL CONTRATUAL EM PONTOS-BASE (EX.: 700 = 7%)." }, 400);
    }
    const percentageRentPaid = body.percentageRentPaid === true || body.percentageRentPaid === 1 ? 1 : 0;
    const notes = safeText(body.notes, 2000);

    const database = await getD1();
    const who = actor.displayName || "Administrador";

    const duplicate = await database
      .prepare(
        `SELECT id FROM finance_mall_declarations
         WHERE company_id=?1 AND lower(mall_name)=lower(?2) AND competence_month=?3 AND id<>?4`,
      )
      .bind(companyId, mallName, competenceMonth, editId || "")
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse({ error: "JÁ EXISTE UMA DECLARAÇÃO PARA ESSA LOJA/SHOPPING/COMPETÊNCIA." }, 409);
    }

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM finance_mall_declarations WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "DECLARAÇÃO NÃO ENCONTRADA." }, 404);
      await database
        .prepare(
          `UPDATE finance_mall_declarations SET
             mall_name=?1, company_id=?2, company_name=?3, competence_month=?4,
             real_revenue_cents=?5, avg_declared_cents=?6, suggested_declared_cents=?7,
             declared_cents=?8, declaration_date=?9, contract_percent_bps=?10,
             minimum_rent_cents=?11, percentage_rent_cents=?12, percentage_rent_paid=?13,
             amount_paid_cents=?14, notes=?15,
             updated_by=?16, updated_by_name=?17, updated_at=CURRENT_TIMESTAMP
           WHERE id=?18`,
        )
        .bind(
          mallName, companyId, companyName, competenceMonth, realRevenueCents, avgDeclaredCents,
          suggestedDeclaredCents, declaredCents, declarationDate, contractPercentBps, minimumRentCents,
          percentageRentCents, percentageRentPaid, amountPaidCents, notes, actor.id, who, editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_mall_declarations
          (id, mall_name, company_id, company_name, competence_month, real_revenue_cents,
           avg_declared_cents, suggested_declared_cents, declared_cents, declaration_date,
           contract_percent_bps, minimum_rent_cents, percentage_rent_cents, percentage_rent_paid,
           amount_paid_cents, notes, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,CURRENT_TIMESTAMP,?17,?18,CURRENT_TIMESTAMP)`,
      )
      .bind(
        id, mallName, companyId, companyName, competenceMonth, realRevenueCents, avgDeclaredCents,
        suggestedDeclaredCents, declaredCents, declarationDate, contractPercentBps, minimumRentCents,
        percentageRentCents, percentageRentPaid, amountPaidCents, notes, actor.id, who,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a declaração de shopping.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A DECLARAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR DECLARAÇÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "DECLARAÇÃO INVÁLIDA." }, 400);
  try {
    const database = await getD1();
    const attachments = await database
      .prepare("SELECT r2_key AS r2Key FROM finance_mall_declaration_attachments WHERE declaration_id=?1")
      .bind(id)
      .all<{ r2Key: string }>();
    const keys = (attachments.results ?? []).map((a) => a.r2Key).filter(Boolean);
    if (keys.length) {
      try {
        const { documentsBucket } = await import("../../documents/shared");
        const bucket = await documentsBucket();
        await bucket.delete(keys);
      } catch (bucketError) {
        console.error("Falha ao remover anexos da declaração.", bucketError);
      }
    }
    await database.prepare("DELETE FROM finance_mall_declaration_attachments WHERE declaration_id=?1").bind(id).run();
    await database.prepare("DELETE FROM finance_mall_declarations WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a declaração de shopping.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A DECLARAÇÃO." }, 500);
  }
}
