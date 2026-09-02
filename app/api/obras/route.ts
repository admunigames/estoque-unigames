import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { documentsBucket } from "../documents/shared";
import { loadCompanyList } from "../finance/shared";
import {
  DATE_PATTERN,
  OBRA_COLUMNS,
  OBRA_ENTRY_COLUMNS,
  OBRA_KINDS,
  OBRA_PAYMENT_METHODS,
  OBRA_STATUSES,
  UUID_PATTERN,
  actorName,
  canManageWorks,
  centsValue,
  identity,
  isOneOf,
  jsonResponse,
  safeText,
  sameOrigin,
  type Database,
  type Identity,
} from "./shared";

type JsonMap = Record<string, unknown>;

type ObraRow = {
  id: string;
  companyId: string;
  companyName: string;
  title: string;
  description: string;
  kind: string;
  responsible: string;
  supplierId: string;
  budgetCents: number;
  startDate: string;
  expectedEndDate: string;
  endDate: string;
  status: string;
  notes: string;
};

async function loadRealizedByObra(database: Database, obraIds: string[]) {
  const map = new Map<string, number>();
  if (!obraIds.length) return map;
  const placeholders = obraIds.map((_id, i) => `?${i + 1}`).join(",");
  const result = await database
    .prepare(
      `SELECT obra_id AS obraId, COALESCE(SUM(amount_cents), 0) AS total
       FROM obra_entries WHERE obra_id IN (${placeholders}) GROUP BY obra_id`,
    )
    .bind(...obraIds)
    .all<{ obraId: string; total: number }>();
  for (const row of result.results ?? []) map.set(row.obraId, Number(row.total || 0));
  return map;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageWorks(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR OBRAS." }, 403);
  }

  const url = new URL(request.url);
  const id = safeText(url.searchParams.get("id"), 80);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const status = safeText(url.searchParams.get("status"), 20);

  try {
    const database = await getD1();

    if (id) {
      if (!UUID_PATTERN.test(id)) return jsonResponse({ error: "OBRA INVÁLIDA." }, 400);
      const obra = await database
        .prepare(`SELECT ${OBRA_COLUMNS} FROM obras WHERE id=?1 LIMIT 1`)
        .bind(id)
        .first<ObraRow>();
      if (!obra) return jsonResponse({ error: "OBRA NÃO ENCONTRADA." }, 404);
      const entriesResult = await database
        .prepare(`SELECT ${OBRA_ENTRY_COLUMNS} FROM obra_entries WHERE obra_id=?1 ORDER BY entry_date ASC, created_at ASC`)
        .bind(id)
        .all();
      const entries = entriesResult.results ?? [];
      const realizedCents = entries.reduce((sum, row) => sum + Number((row as { amountCents: number }).amountCents || 0), 0);
      return jsonResponse({ obra: { ...obra, realizedCents }, entries });
    }

    const conditions: string[] = [];
    const params: string[] = [];
    if (companyId) {
      params.push(companyId);
      conditions.push(`company_id=?${params.length}`);
    }
    if (status && isOneOf(OBRA_STATUSES, status)) {
      params.push(status);
      conditions.push(`status=?${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(`SELECT ${OBRA_COLUMNS} FROM obras ${where} ORDER BY created_at DESC`)
      .bind(...params)
      .all<ObraRow>();
    const obras = result.results ?? [];
    const realized = await loadRealizedByObra(database, obras.map((o) => o.id));
    const rows = obras.map((o) => ({ ...o, realizedCents: realized.get(o.id) ?? 0 }));
    return jsonResponse({
      obras: rows,
      totalBudgetCents: rows.reduce((s, o) => s + Number(o.budgetCents || 0), 0),
      totalRealizedCents: rows.reduce((s, o) => s + o.realizedCents, 0),
    });
  } catch (error) {
    console.error("Não foi possível carregar as obras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS OBRAS." }, 500);
  }
}

async function saveObra(database: Database, actor: Identity, body: JsonMap) {
  const editId = safeText(body.id, 80);
  const title = safeText(body.title, 160);
  const description = safeText(body.description, 2000);
  const kind = safeText(body.kind, 20) || "reforma";
  const responsible = safeText(body.responsible, 160);
  const supplierId = safeText(body.supplierId, 80);
  const companyId = safeText(body.companyId, 80);
  const status = safeText(body.status, 20) || "planejada";
  const notes = safeText(body.notes, 2000);
  const budgetCents = body.budgetCents === undefined || body.budgetCents === null || body.budgetCents === ""
    ? 0
    : centsValue(body.budgetCents);
  const startDate = safeText(body.startDate, 10);
  const expectedEndDate = safeText(body.expectedEndDate, 10);
  const endDate = safeText(body.endDate, 10);

  if (!title) return jsonResponse({ error: "INFORME O TÍTULO DA OBRA." }, 400);
  if (!isOneOf(OBRA_KINDS, kind)) return jsonResponse({ error: "TIPO DE OBRA INVÁLIDO." }, 400);
  if (!isOneOf(OBRA_STATUSES, status)) return jsonResponse({ error: "STATUS DE OBRA INVÁLIDO." }, 400);
  if (!Number.isFinite(budgetCents) || budgetCents < 0) {
    return jsonResponse({ error: "INFORME UM VALOR ORÇADO VÁLIDO." }, 400);
  }
  for (const [label, value] of [
    ["INÍCIO", startDate],
    ["PREVISÃO DE CONCLUSÃO", expectedEndDate],
    ["CONCLUSÃO", endDate],
  ] as Array<[string, string]>) {
    if (value && !DATE_PATTERN.test(value)) {
      return jsonResponse({ error: `INFORME UMA DATA DE ${label} VÁLIDA (AAAA-MM-DD).` }, 400);
    }
  }

  let companyName = "";
  if (companyId) {
    const companies = await loadCompanyList(database);
    const company = companies.find((item) => item.id === companyId);
    if (!company) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    companyName = company.name;
  }

  if (editId) {
    const existing = await database
      .prepare("SELECT id FROM obras WHERE id=?1 LIMIT 1")
      .bind(editId)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "OBRA NÃO ENCONTRADA." }, 404);
    await database
      .prepare(
        `UPDATE obras
         SET company_id=?1, company_name=?2, title=?3, description=?4, kind=?5, responsible=?6,
             supplier_id=?7, budget_cents=?8, start_date=?9, expected_end_date=?10, end_date=?11,
             status=?12, notes=?13, updated_by=?14, updated_by_name=?15, updated_at=CURRENT_TIMESTAMP
         WHERE id=?16`,
      )
      .bind(
        companyId,
        companyName,
        title,
        description,
        kind,
        responsible,
        supplierId,
        budgetCents,
        startDate,
        expectedEndDate,
        endDate,
        status,
        notes,
        actor.id,
        actorName(actor),
        editId,
      )
      .run();
    return jsonResponse({ updated: true, id: editId });
  }

  const id = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO obras
        (id, company_id, company_name, title, description, kind, responsible, supplier_id,
         budget_cents, start_date, expected_end_date, end_date, status, notes, created_by,
         created_by_name, created_at, updated_by, updated_by_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
               CURRENT_TIMESTAMP, ?15, ?16, CURRENT_TIMESTAMP)`,
    )
    .bind(
      id,
      companyId,
      companyName,
      title,
      description,
      kind,
      responsible,
      supplierId,
      budgetCents,
      startDate,
      expectedEndDate,
      endDate,
      status,
      notes,
      actor.id,
      actorName(actor),
    )
    .run();
  return jsonResponse({ created: true, id }, 201);
}

async function saveEntry(database: Database, actor: Identity, body: JsonMap) {
  const editId = safeText(body.entryId, 80);
  const obraId = safeText(body.obraId, 80);
  const description = safeText(body.description, 300);
  const supplier = safeText(body.supplier, 160);
  const entryDate = safeText(body.entryDate, 10);
  const paymentMethod = safeText(body.paymentMethod, 20) || "outros";
  const notes = safeText(body.notes, 1000);
  const amountCents = centsValue(body.amountCents);

  if (!UUID_PATTERN.test(obraId)) return jsonResponse({ error: "OBRA INVÁLIDA." }, 400);
  if (!description) return jsonResponse({ error: "INFORME A DESCRIÇÃO DO LANÇAMENTO." }, 400);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return jsonResponse({ error: "INFORME UM VALOR MAIOR QUE ZERO." }, 400);
  }
  if (entryDate && !DATE_PATTERN.test(entryDate)) {
    return jsonResponse({ error: "INFORME UMA DATA VÁLIDA (AAAA-MM-DD)." }, 400);
  }
  if (!isOneOf(OBRA_PAYMENT_METHODS, paymentMethod)) {
    return jsonResponse({ error: "FORMA DE PAGAMENTO INVÁLIDA." }, 400);
  }

  const obra = await database.prepare("SELECT id FROM obras WHERE id=?1 LIMIT 1").bind(obraId).first<{ id: string }>();
  if (!obra) return jsonResponse({ error: "OBRA NÃO ENCONTRADA." }, 404);

  if (editId) {
    const existing = await database
      .prepare("SELECT id FROM obra_entries WHERE id=?1 AND obra_id=?2 LIMIT 1")
      .bind(editId, obraId)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
    await database
      .prepare(
        `UPDATE obra_entries
         SET description=?1, supplier=?2, amount_cents=?3, entry_date=?4, payment_method=?5, notes=?6
         WHERE id=?7`,
      )
      .bind(description, supplier, amountCents, entryDate, paymentMethod, notes, editId)
      .run();
    return jsonResponse({ updated: true, id: editId });
  }

  const id = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO obra_entries
        (id, obra_id, description, supplier, amount_cents, entry_date, payment_method, notes,
         created_by, created_by_name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP)`,
    )
    .bind(id, obraId, description, supplier, amountCents, entryDate, paymentMethod, notes, actor.id, actorName(actor))
    .run();
  return jsonResponse({ created: true, id }, 201);
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageWorks(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR OBRAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20) || "save_obra";
    const database = await getD1();
    if (action === "save_obra") return await saveObra(database, actor, body);
    if (action === "save_entry") return await saveEntry(database, actor, body);
    return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível salvar a obra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageWorks(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR OBRAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const url = new URL(request.url);
  const id = safeText(url.searchParams.get("id"), 80);
  const entryId = safeText(url.searchParams.get("entryId"), 80);

  try {
    const database = await getD1();
    if (entryId) {
      if (!UUID_PATTERN.test(entryId)) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
      const entry = await database
        .prepare("SELECT attachment_r2_key AS attachmentR2Key FROM obra_entries WHERE id=?1 LIMIT 1")
        .bind(entryId)
        .first<{ attachmentR2Key: string }>();
      await database.prepare("DELETE FROM obra_entries WHERE id=?1").bind(entryId).run();
      if (entry?.attachmentR2Key) {
        const bucket = await documentsBucket();
        await bucket.delete(entry.attachmentR2Key).catch(() => undefined);
      }
      return jsonResponse({ deleted: true });
    }
    if (!UUID_PATTERN.test(id)) return jsonResponse({ error: "OBRA INVÁLIDA." }, 400);
    const attachments = await database
      .prepare("SELECT attachment_r2_key AS attachmentR2Key FROM obra_entries WHERE obra_id=?1 AND attachment_r2_key <> ''")
      .bind(id)
      .all<{ attachmentR2Key: string }>();
    await database.batch([
      database.prepare("DELETE FROM obra_entries WHERE obra_id=?1").bind(id),
      database.prepare("DELETE FROM obras WHERE id=?1").bind(id),
    ]);
    const keys = (attachments.results ?? []).map((row) => row.attachmentR2Key).filter(Boolean);
    if (keys.length) {
      const bucket = await documentsBucket();
      await bucket.delete(keys).catch(() => undefined);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a obra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR." }, 500);
  }
}
