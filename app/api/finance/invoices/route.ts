import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { planInvoiceCreate } from "./create";
import { canViewInvoices, INVOICE_ROW_SELECT, purchaseOrderNfAttachmentCopyStatements } from "./shared";

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
      // Só o "?" ainda sem número (um fragmento pode ter mais de um).
      fragment = fragment.replace(/\?(?!\d)/, `?${values.length}`);
    }
    conditions.push(fragment);
  }

  // "__none__" = SEM LOJA (escritório / PF / outros).
  if (effectiveCompanyId === "__none__") addCondition("company_id = ''");
  else if (effectiveCompanyId) addCondition("company_id = ?", effectiveCompanyId);
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
  const purchaseOrderId = safeText(params.get("purchaseOrderId"), 80);
  if (purchaseOrderId) addCondition("purchase_order_id = ?", purchaseOrderId);
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
  const financeCan = canViewInvoices(actor) &&
    (actor.role === "admin" || actor.permissions.includes("finance:manage") || actor.permissions.includes("payables:invoices_reconcile"));
  // Compras (purchases_draft:manage) também cadastra, mas SÓ a NF que nasce
  // do pedido de compra ("CRIAR NOTA FISCAL PARA ESTE PEDIDO") — conferido
  // abaixo, depois de ler o corpo.
  const comprasCan = actor.permissions.includes("purchases_draft:manage");
  if (!financeCan && !comprasCan) {
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
  try {
    const body = (await request.json()) as JsonMap;
    const viaPurchaseOrder = !financeCan;
    if (viaPurchaseOrder && !safeText(body.purchaseOrderId, 80)) {
      return jsonResponse({ error: "PELO COMPRAS, A NOTA FISCAL SÓ PODE SER CRIADA A PARTIR DO PEDIDO DE COMPRA." }, 403);
    }
    // Pelo pedido de compra vale o alcance do Compras (central vê todas as lojas).
    const allStores = canSeeAllStores(scopeActor, viaPurchaseOrder ? "purchases_draft:manage" : "finance:manage");

    const database = await getD1();
    const plan = await planInvoiceCreate(database, actor, scopeActor, allStores, viaPurchaseOrder, body);
    if ("reply" in plan) return jsonResponse(plan.reply.payload, plan.reply.status);
    const { id, purchaseOrderId, statements } = plan;
    const actorName = actor.displayName || "Administrador";
    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));

    // Reaproveita o anexo da NF já enviado no pedido de Compras (Fase C),
    // sem exigir novo upload no Financeiro — ver purchaseOrderNfAttachmentCopyStatements.
    if (purchaseOrderId) {
      const attachmentStatements = await purchaseOrderNfAttachmentCopyStatements(database, purchaseOrderId, id);
      for (const [sql, values] of attachmentStatements) {
        await database.prepare(sql).bind(...values).run();
      }
      if (attachmentStatements.length) {
        await database
          .prepare(
            `INSERT INTO supplier_invoice_events (id, invoice_id, event_type, description, metadata_json, actor_id, actor_name, created_at)
             VALUES (?1,?2,'attachment_added',?3,'{}',?4,?5,CURRENT_TIMESTAMP)`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            `ANEXO DA NF REAPROVEITADO AUTOMATICAMENTE DO PEDIDO DE COMPRAS (${attachmentStatements.length} ARQUIVO(S)).`,
            actor.id,
            actorName,
          )
          .run();
      }
    }

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a nota fiscal.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A NOTA FISCAL." }, 500);
  }
}
