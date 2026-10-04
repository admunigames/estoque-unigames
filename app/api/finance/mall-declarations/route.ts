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
import { insertDeclarationStatement, parseDeclarationValues } from "./shared";

// Declaração de Vendas (ex-"Declaração de Shopping", Financeiro — Fase 8).
// Um registro por loja/competência, com histórico mensal, comparativo e
// alerta de aluguel percentual (ver app/lib/mall-declarations.ts).
//
// Desde o ajuste 1/9 (04/10/2026) SHOPPING, DATA DA DECLARAÇÃO, MÉDIA
// DECLARADA e VALOR PAGO saíram da tela: as colunas continuam no banco (sem
// migration), só não são mais lidas/escritas. mall_name é gravado '' em
// registros novos — o índice único vira, na prática, loja + competência — e
// fica intocado nos antigos. Sugerido e aluguel percentual são sempre
// recalculados aqui; o faturamento real, se vier vazio, é puxado de
// finance_store_revenue. Cadastro em lote: ./batch; ações em lote: ./bulk.

type Row = Record<string, unknown>;

const SELECT_COLUMNS = `id, company_id AS companyId, company_name AS companyName,
  competence_month AS competenceMonth, real_revenue_cents AS realRevenueCents,
  declared_cents AS declaredCents,
  contract_percent_bps AS contractPercentBps, minimum_rent_cents AS minimumRentCents,
  percentage_rent_paid AS percentageRentPaid, notes,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

function withDerived(row: Row) {
  const derived = deriveMallDeclaration({
    realRevenueCents: Number(row.realRevenueCents) || 0,
    declaredCents: Number(row.declaredCents) || 0,
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
         ${whereSql} ORDER BY competence_month DESC, company_name ASC LIMIT 1000`,
      )
      .bind(...values)
      .all<Row>();
    return jsonResponse({ rows: (rows.results ?? []).map(withDerived) });
  } catch (error) {
    console.error("Não foi possível carregar as declarações de vendas.", error);
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
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    const competenceMonth = safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) return jsonResponse({ error: "INFORME A COMPETÊNCIA (AAAA-MM)." }, 400);

    const values = parseDeclarationValues(body);
    if ("error" in values) return jsonResponse(values, 400);
    const percentageRentPaid = body.percentageRentPaid === true || body.percentageRentPaid === 1 ? 1 : 0;
    const notes = safeText(body.notes, 2000);

    const database = await getD1();
    const who = actor.displayName || "Administrador";

    let realRevenueCents = values.realRevenueCents;
    if (!realRevenueCents) {
      const revenue = await database
        .prepare("SELECT amount_cents AS amountCents FROM finance_store_revenue WHERE store_id=?1 AND month=?2")
        .bind(companyId, competenceMonth)
        .first<{ amountCents: number }>();
      realRevenueCents = Number(revenue?.amountCents) || 0;
    }
    const derived = deriveMallDeclaration({ ...values, realRevenueCents });

    const existing = editId
      ? await database
          .prepare("SELECT company_id AS companyId, competence_month AS competenceMonth FROM finance_mall_declarations WHERE id=?1")
          .bind(editId)
          .first<{ companyId: string; competenceMonth: string }>()
      : null;
    if (editId && !existing) return jsonResponse({ error: "DECLARAÇÃO NÃO ENCONTRADA." }, 404);

    // Só checa duplicidade quando a loja/competência muda: registros antigos
    // da mesma loja/mês com shoppings diferentes continuam editáveis.
    if (!existing || existing.companyId !== companyId || existing.competenceMonth !== competenceMonth) {
      const duplicate = await database
        .prepare("SELECT id FROM finance_mall_declarations WHERE company_id=?1 AND competence_month=?2 LIMIT 1")
        .bind(companyId, competenceMonth)
        .first<{ id: string }>();
      if (duplicate) {
        return jsonResponse({ error: "JÁ EXISTE UMA DECLARAÇÃO PARA ESSA LOJA NESTA COMPETÊNCIA." }, 409);
      }
    }

    if (editId) {
      await database
        .prepare(
          `UPDATE finance_mall_declarations SET
             company_id=?1, company_name=?2, competence_month=?3,
             real_revenue_cents=?4, suggested_declared_cents=?5, declared_cents=?6,
             contract_percent_bps=?7, minimum_rent_cents=?8, percentage_rent_cents=?9,
             percentage_rent_paid=?10, notes=?11,
             updated_by=?12, updated_by_name=?13, updated_at=CURRENT_TIMESTAMP
           WHERE id=?14`,
        )
        .bind(
          companyId, companyName, competenceMonth, realRevenueCents, derived.breakpointCents,
          values.declaredCents, values.contractPercentBps, values.minimumRentCents,
          derived.percentageRentCents, percentageRentPaid, notes, actor.id, who, editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await insertDeclarationStatement(database, {
      id, companyId, companyName, competenceMonth, realRevenueCents,
      declaredCents: values.declaredCents, contractPercentBps: values.contractPercentBps,
      minimumRentCents: values.minimumRentCents, percentageRentPaid, notes, actorId: actor.id, who,
    }).run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a declaração de vendas.", error);
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
    console.error("Não foi possível excluir a declaração de vendas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A DECLARAÇÃO." }, 500);
  }
}
