import { getD1 } from "../../../../../db";
import { isValidCpfOrCnpj } from "../../../../lib/br-documents";
import { canPurchases, unauthorizedResponse } from "../../../../lib/notion";
import { computeInstallmentTotals } from "../../../../lib/supplier-invoice-status";
import { DATE_PATTERN } from "../../../finance/payables/shared";
import { MONTH_PATTERN, safeText } from "../../../finance/shared";
import { INVOICE_ROW_SELECT, loadInstallments, loadInvoice } from "../../../finance/invoices/shared";

type JsonMap = Record<string, unknown>;

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identity(request: Request) {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
  };
}

function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim() || "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

// GET/POST/PATCH da NF vinculada a um pedido de Compras (Notion). Sempre
// que uma tela do Financeiro precisar de mais do que este resumo, ela usa
// as rotas de app/api/finance/invoices/* — esta rota é o único ponto de
// contato do módulo Compras com a NF, e propositalmente NÃO expõe
// pagamentos/duplicatas pra edição (só leitura, ver requisito de frontend).
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canPurchases(request, "purchases:view")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER O PEDIDO." }, 403);
  }
  const { id } = await context.params;
  const notionPurchaseId = id.trim();
  if (!notionPurchaseId) return jsonResponse({ error: "PEDIDO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const invoice = await database
      .prepare(`SELECT ${INVOICE_ROW_SELECT} FROM supplier_invoices WHERE notion_purchase_id=?1 ORDER BY created_at DESC LIMIT 1`)
      .bind(notionPurchaseId)
      .first();
    if (!invoice) return jsonResponse({ invoice: null });

    const invoiceId = (invoice as { id: string }).id;
    const installments = await loadInstallments(database, invoiceId);
    const totals = computeInstallmentTotals((invoice as { totalAmountCents: number }).totalAmountCents, installments);
    return jsonResponse({
      invoice,
      installmentsCount: installments.filter((installment) => !installment.canceled).length,
      totals,
    });
  } catch (error) {
    console.error("Não foi possível carregar a nota fiscal do pedido.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A NOTA FISCAL DO PEDIDO." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canPurchases(request, "purchases:edit")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR A NOTA FISCAL DESTE PEDIDO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const { id } = await context.params;
  const notionPurchaseId = id.trim();
  if (!notionPurchaseId) return jsonResponse({ error: "PEDIDO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supplier_invoices WHERE notion_purchase_id=?1 LIMIT 1")
      .bind(notionPurchaseId)
      .first<{ id: string }>();
    // Decisão de escopo: 1 NF ativa por pedido do Notion (o pedido tem uma
    // única "NOTA FISCAL" no Notion também) — se já existe, use PATCH pra
    // editar em vez de criar outra.
    if (existing) {
      return jsonResponse({ error: "ESTE PEDIDO JÁ TEM UMA NOTA FISCAL CADASTRADA. EDITE-A EM VEZ DE CRIAR OUTRA." }, 409);
    }

    const body = (await request.json()) as JsonMap;
    const companyId = safeText(body.companyId, 80);
    if (!companyId) return jsonResponse({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
    const companyName = safeText(body.companyName, 160);
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
    const competenceMonth = safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }

    const duplicate = await database
      .prepare(
        `SELECT id FROM supplier_invoices WHERE company_id=?1 AND supplier_id=?2 AND invoice_number=?3 AND series=?4`,
      )
      .bind(companyId, supplierId, invoiceNumber, series)
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse(
        { error: "JÁ EXISTE UMA NOTA FISCAL CADASTRADA COM ESSE NÚMERO/SÉRIE PARA ESSE FORNECEDOR E LOJA." },
        409,
      );
    }

    const actor = identity(request);
    const actorName = actor.displayName || "Usuário";
    const invoiceId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO supplier_invoices
          (id, company_id, company_name, supplier_id, supplier_document, invoice_number, series, access_key,
           issue_date, competence_month, notion_purchase_id, notion_purchase_url, total_amount_cents,
           operational_status, notes, origin, financial_status, created_by, created_by_name,
           created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'purchase','aguardando_envio',?16,?17,
           CURRENT_TIMESTAMP,?16,?17,CURRENT_TIMESTAMP)`,
      )
      .bind(
        invoiceId,
        companyId,
        companyName,
        supplierId,
        supplierDocument,
        invoiceNumber,
        series,
        accessKey,
        issueDate,
        competenceMonth,
        notionPurchaseId,
        safeText(body.notionPurchaseUrl, 500),
        totalAmountCents,
        safeText(body.operationalStatus, 60),
        safeText(body.notes, 2000),
        actor.id,
        actorName,
      )
      .run();

    await database
      .prepare(
        `INSERT INTO supplier_invoice_events (id, invoice_id, event_type, description, metadata_json, actor_id, actor_name, created_at)
         VALUES (?1,?2,'created','NOTA FISCAL CADASTRADA A PARTIR DO PEDIDO DE COMPRAS.','{}',?3,?4,CURRENT_TIMESTAMP)`,
      )
      .bind(crypto.randomUUID(), invoiceId, actor.id, actorName)
      .run();

    return jsonResponse({ created: true, id: invoiceId }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a nota fiscal do pedido.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A NOTA FISCAL DO PEDIDO." }, 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canPurchases(request, "purchases:edit")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR A NOTA FISCAL DESTE PEDIDO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const { id } = await context.params;
  const notionPurchaseId = id.trim();

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supplier_invoices WHERE notion_purchase_id=?1 ORDER BY created_at DESC LIMIT 1")
      .bind(notionPurchaseId)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "ESTE PEDIDO AINDA NÃO TEM NOTA FISCAL CADASTRADA." }, 404);

    const invoice = await loadInvoice(database, existing.id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    if (invoice.canceled) return jsonResponse({ error: "ESTA NOTA FISCAL ESTÁ CANCELADA." }, 409);
    // Só edita pelo lado de Compras enquanto a NF ainda não está com o
    // Financeiro (ou foi devolvida pra correção) — depois disso, a edição
    // passa a ser feita pelas rotas de app/api/finance/invoices/*.
    if (invoice.sentToFinanceAt && !invoice.pendingCorrection) {
      return jsonResponse(
        { error: "ESTA NOTA FISCAL JÁ ESTÁ COM O FINANCEIRO. PEÇA A DEVOLUÇÃO PARA EDITAR." },
        409,
      );
    }

    const body = (await request.json()) as JsonMap;
    const supplierId = body.supplierId === undefined ? invoice.supplierId : safeText(body.supplierId, 80);
    const supplierDocument =
      body.supplierDocument === undefined ? invoice.supplierDocument : safeText(body.supplierDocument, 20);
    if (supplierDocument && !isValidCpfOrCnpj(supplierDocument)) {
      return jsonResponse({ error: "O CNPJ/CPF DO FORNECEDOR É INVÁLIDO." }, 400);
    }
    const invoiceNumber = body.invoiceNumber === undefined ? invoice.invoiceNumber : safeText(body.invoiceNumber, 60);
    const series = body.series === undefined ? invoice.series : safeText(body.series, 20);
    const accessKey = body.accessKey === undefined ? invoice.accessKey : safeText(body.accessKey, 44);
    if (accessKey && !/^\d{44}$/.test(accessKey)) {
      return jsonResponse({ error: "A CHAVE DE ACESSO DA NF-E DEVE TER 44 DÍGITOS." }, 400);
    }
    const issueDate = body.issueDate === undefined ? invoice.issueDate : safeText(body.issueDate, 10);
    if (issueDate && !DATE_PATTERN.test(issueDate)) return jsonResponse({ error: "DATA DE EMISSÃO INVÁLIDA." }, 400);
    const competenceMonth = body.competenceMonth === undefined ? invoice.competenceMonth : safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }
    const totalAmountCents =
      body.totalAmountCents === undefined ? invoice.totalAmountCents : Number(body.totalAmountCents);
    if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR TOTAL VÁLIDO EM CENTAVOS." }, 400);
    }
    const operationalStatus =
      body.operationalStatus === undefined ? invoice.operationalStatus : safeText(body.operationalStatus, 60);
    const notes = body.notes === undefined ? invoice.notes : safeText(body.notes, 2000);

    const actor = identity(request);
    const actorName = actor.displayName || "Usuário";
    await database
      .prepare(
        `UPDATE supplier_invoices
         SET supplier_id=?1, supplier_document=?2, invoice_number=?3, series=?4, access_key=?5, issue_date=?6,
             competence_month=?7, total_amount_cents=?8, operational_status=?9, notes=?10,
             updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP
         WHERE id=?13`,
      )
      .bind(
        supplierId,
        supplierDocument,
        invoiceNumber,
        series,
        accessKey,
        issueDate,
        competenceMonth,
        totalAmountCents,
        operationalStatus,
        notes,
        actor.id,
        actorName,
        invoice.id,
      )
      .run();

    return jsonResponse({ updated: true, id: invoice.id });
  } catch (error) {
    console.error("Não foi possível editar a nota fiscal do pedido.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A NOTA FISCAL DO PEDIDO." }, 500);
  }
}
