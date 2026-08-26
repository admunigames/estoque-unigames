import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { isValidCpfOrCnpj } from "../../../lib/br-documents";
import { computeInvoiceFinancialStatus } from "../../../lib/supplier-invoice-status";
import { identity, jsonResponse, safeText, sameOrigin, MONTH_PATTERN, type JsonMap } from "../shared";
import { DATE_PATTERN } from "../payables/shared";
import { canViewInvoices, INVOICE_ROW_SELECT } from "./shared";

type ListRow = Record<string, unknown>;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewInvoices(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER NOTAS FISCAIS." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const url = new URL(request.url);
  const params = url.searchParams;

  const companyId = safeText(params.get("companyId"), 80);
  if (!allStores && companyId && companyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? companyId : scopeActor.companyId;

  const conditions: string[] = [];
  const values: unknown[] = [];
  function addCondition(sqlFragment: string, ...args: unknown[]) {
    let fragment = sqlFragment;
    for (const arg of args) {
      values.push(arg);
      fragment = fragment.replace("?", `?${values.length}`);
    }
    conditions.push(fragment);
  }

  if (effectiveCompanyId) addCondition("company_id = ?", effectiveCompanyId);
  const statuses = params.getAll("status").map((value) => safeText(value, 30)).filter(Boolean);
  if (statuses.length === 1) addCondition("financial_status = ?", statuses[0]);
  if (statuses.length > 1) {
    const placeholders = statuses.map((status) => {
      values.push(status);
      return `?${values.length}`;
    });
    conditions.push(`financial_status IN (${placeholders.join(",")})`);
  }
  const supplierId = safeText(params.get("supplierId"), 80);
  if (supplierId) addCondition("supplier_id = ?", supplierId);
  const notionPurchaseId = safeText(params.get("notionPurchaseId"), 120);
  if (notionPurchaseId) addCondition("notion_purchase_id = ?", notionPurchaseId);
  const origin = safeText(params.get("origin"), 20);
  if (origin === "purchase" || origin === "manual") addCondition("origin = ?", origin);

  const search = safeText(params.get("search"), 120);
  if (search) {
    addCondition(
      `(invoice_number ILIKE ? OR access_key ILIKE ? OR supplier_document ILIKE ?
        OR EXISTS (SELECT 1 FROM finance_suppliers s WHERE s.id = supplier_invoices.supplier_id AND s.name ILIKE ?))`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    );
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get("pageSize")) || 20));

  try {
    const database = await getD1();
    const totalsRow = await database
      .prepare(`SELECT COUNT(*) AS count FROM supplier_invoices ${whereSql}`)
      .bind(...values)
      .first<{ count: number }>();

    const rowsValues = [...values, pageSize, (page - 1) * pageSize];
    const rows = await database
      .prepare(
        `SELECT ${INVOICE_ROW_SELECT} FROM supplier_invoices
         ${whereSql}
         ORDER BY created_at DESC, id ASC
         LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
      )
      .bind(...rowsValues)
      .all<ListRow>();

    return jsonResponse({
      rows: rows.results ?? [],
      page,
      pageSize,
      total: Number(totalsRow?.count ?? 0),
    });
  } catch (error) {
    console.error("Não foi possível carregar as notas fiscais.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS NOTAS FISCAIS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewInvoices(actor) || !(actor.role === "admin" || actor.permissions.includes("finance:manage") || actor.permissions.includes("payables:invoices_reconcile"))) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR NOTAS FISCAIS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");

  try {
    const body = (await request.json()) as JsonMap;

    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
    if (!allStores && companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ SÓ PODE CADASTRAR NOTAS PARA A PRÓPRIA LOJA." }, 403);
    }

    const invoiceNumber = safeText(body.invoiceNumber, 60);
    if (!invoiceNumber) return jsonResponse({ error: "INFORME O NÚMERO DA NOTA FISCAL." }, 400);
    const series = safeText(body.series, 20);
    const accessKey = safeText(body.accessKey, 44);
    if (accessKey && !/^\d{44}$/.test(accessKey)) {
      return jsonResponse({ error: "A CHAVE DE ACESSO DA NF-E DEVE TER 44 DÍGITOS." }, 400);
    }
    const supplierId = safeText(body.supplierId, 80);
    const supplierDocument = safeText(body.supplierDocument, 20);
    if (supplierDocument && !isValidCpfOrCnpj(supplierDocument)) {
      return jsonResponse({ error: "O CNPJ/CPF DO FORNECEDOR É INVÁLIDO." }, 400);
    }

    const totalAmountCents = Number(body.totalAmountCents);
    if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR TOTAL VÁLIDO EM CENTAVOS." }, 400);
    }

    const issueDate = safeText(body.issueDate, 10);
    if (issueDate && !DATE_PATTERN.test(issueDate)) return jsonResponse({ error: "DATA DE EMISSÃO INVÁLIDA." }, 400);
    const entryDate = safeText(body.entryDate, 10);
    if (entryDate && !DATE_PATTERN.test(entryDate)) return jsonResponse({ error: "DATA DE ENTRADA INVÁLIDA." }, 400);

    const competenceMonth = safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }

    const financeCategoryId = safeText(body.financeCategoryId, 80);
    const financeItemId = safeText(body.financeItemId, 80);
    const notes = safeText(body.notes, 2000);

    const database = await getD1();

    const costCenterId = safeText(body.costCenterId, 80);
    let costCenter = "";
    if (costCenterId) {
      const costCenterRow = await database
        .prepare("SELECT name FROM finance_cost_centers WHERE id=?1")
        .bind(costCenterId)
        .first<{ name: string }>();
      if (!costCenterRow) return jsonResponse({ error: "CENTRO DE CUSTO NÃO ENCONTRADO." }, 400);
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
      return jsonResponse(
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
        return jsonResponse({ error: "JÁ EXISTE UMA NOTA FISCAL CADASTRADA COM ESSA CHAVE DE ACESSO." }, 409);
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

    await database
      .prepare(
        `INSERT INTO supplier_invoices
          (id, company_id, company_name, supplier_id, supplier_document, invoice_number, series, access_key,
           issue_date, entry_date, competence_month, notion_purchase_id, notion_purchase_url, total_amount_cents,
           finance_category_id, finance_item_id, cost_center, notes, origin, financial_status,
           created_by, created_by_name, sent_to_finance_by, sent_to_finance_by_name, sent_to_finance_at,
           created_at, updated_by, updated_by_name, updated_at, cost_center_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'','',?12,?13,?14,?15,?16,'manual',?17,
           ?18,?19,?18,?19,?20,CURRENT_TIMESTAMP,?18,?19,CURRENT_TIMESTAMP,?21)`,
      )
      .bind(
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
      )
      .run();

    await database
      .prepare(
        `INSERT INTO supplier_invoice_events (id, invoice_id, event_type, description, metadata_json, actor_id, actor_name, created_at)
         VALUES (?1,?2,'created','NOTA FISCAL CADASTRADA MANUALMENTE NO FINANCEIRO.','{}',?3,?4,CURRENT_TIMESTAMP)`,
      )
      .bind(crypto.randomUUID(), id, actor.id, actorName)
      .run();

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a nota fiscal.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A NOTA FISCAL." }, 500);
  }
}
