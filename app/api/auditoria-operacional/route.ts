import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { hasCompany } from "../../lib/access-scope";
import { isSellingStore } from "../../lib/selling-stores";
import { recifeDate } from "../../lib/ordens-servico";
import { AOP_ANSWERS, AOP_DEFAULT_ITEMS, AOP_SECTIONS, buildSummary } from "../../lib/auditoria-operacional";
import { identity as baseIdentity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../assistencia/shared";

// Auditoria Operacional — checklist de loja (permissões auditoria_operacional:
// view/audit/manage/delete). Login com loja vinculada só LÊ as auditorias
// FINALIZADAS da própria loja; sem loja vê todas. Escrita só sem loja.
//   GET                 → auditorias (com a nota por seção) e lojas que vendem
//   GET ?id=<id>        → auditoria + respostas + resumo do que precisa melhorar
//   GET ?items=1        → itens do checklist, inclusive desativados (manage)
//   POST  {companyId}                        → nova auditoria (audit)
//   PUT   {id, answerId, status, notes}     → marca/observa um item (audit, só rascunho)
//   PATCH {id, action:"FINALIZAR"}           → finaliza: todos respondidos (audit)
//   POST  {kind:"item", section, groupName, text}            (manage)
//   PATCH {kind:"item", id, section, groupName, text, active} (manage)
//   PATCH {kind:"item-order", ids:[...]}                      (manage)
//   DELETE {id}                              → exclui a auditoria (delete; deleted=1)
// Os campos status/notes/companyName/action entram no resumo da Auditoria central.

type Actor = ReturnType<typeof baseIdentity> & { companyId: string };
type Company = { id: string; name: string };
type AuditRow = {
  id: string; companyId: string; companyName: string; auditDate: string; auditorName: string; status: string;
  finalizedByName: string; finalizedAt: string; createdAt: string;
};

const NOT_FOUND = "AUDITORIA NÃO ENCONTRADA.";
const AUDIT_SELECT = `SELECT id, company_id AS companyId, company_name AS companyName, audit_date AS auditDate,
  auditor_name AS auditorName, status, finalized_by_name AS finalizedByName, finalized_at AS finalizedAt, created_at AS createdAt
  FROM ops_audits`;

function identity(request: Request): Actor {
  return { ...baseIdentity(request), companyId: safeText(request.headers.get("x-unigames-company-id"), 80) };
}

function can(actor: Actor, action: string) {
  return actor.role === "admin" || actor.permissions.includes(`auditoria_operacional:${action}`);
}

/** Loja vinculada (não admin) só vê a própria loja e só auditorias finalizadas. */
function storeOnly(actor: Actor) {
  return actor.role !== "admin" && hasCompany(actor.companyId);
}

function writeGuard(request: Request, action: string, message: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!can(actor, action)) return { error: jsonResponse({ error: message }, 403) };
  if (storeOnly(actor)) return { error: jsonResponse({ error: "LOGIN DE LOJA SÓ VISUALIZA A AUDITORIA." }, 403) };
  if (!sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

async function loadCompanies(database: D1Database): Promise<Company[]> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  try {
    const list = row?.value ? (JSON.parse(row.value) as Company[]) : [];
    return Array.isArray(list)
      ? list.filter((item) => item && typeof item.id === "string" && isSellingStore(String(item.name || "")))
        .map((item) => ({ id: item.id, name: String(item.name) }))
      : [];
  } catch {
    return [];
  }
}

/** Primeiro acesso: grava os 32 itens do PDF (ids fixos, sem duplicar). */
async function ensureDefaultItems(database: D1Database) {
  const row = await database.prepare("SELECT id FROM ops_audit_items LIMIT 1").first<{ id: string }>();
  if (row) return;
  await database.batch(AOP_DEFAULT_ITEMS.map((item) =>
    database
      .prepare(
        `INSERT INTO ops_audit_items (id, section, group_name, text, sort_order, active, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(item.id, item.section, item.groupName, item.text, item.sortOrder, new Date().toISOString())));
}

async function findAudit(database: D1Database, actor: Actor, id: string) {
  const row = id ? await database.prepare(`${AUDIT_SELECT} WHERE id=?1 AND deleted=0`).bind(id).first<AuditRow>() : null;
  if (!row) return null;
  if (storeOnly(actor) && (row.companyId !== actor.companyId || row.status !== "final")) return null;
  return row;
}

async function loadAnswers(database: D1Database, auditId: string) {
  const result = await database
    .prepare(
      `SELECT id, section, group_name AS groupName, text, answer, note, updated_by_name AS updatedByName, updated_at AS updatedAt
       FROM ops_audit_answers WHERE audit_id=?1 ORDER BY sort_order, id`,
    )
    .bind(auditId)
    .all<{ id: string; section: string; groupName: string; text: string; answer: string; note: string }>();
  return result.results ?? [];
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!["view", "audit", "manage", "delete"].some((action) => can(actor, action))) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À AUDITORIA OPERACIONAL." }, 403);
  }
  const url = new URL(request.url);
  try {
    const database = await getD1();
    if (url.searchParams.get("items")) {
      if (!can(actor, "manage") || storeOnly(actor)) return jsonResponse({ error: "VOCÊ NÃO PODE EDITAR OS ITENS." }, 403);
      await ensureDefaultItems(database);
      const result = await database
        .prepare(
          `SELECT id, section, group_name AS groupName, text, sort_order AS sortOrder, active
           FROM ops_audit_items ORDER BY sort_order, id`,
        )
        .all<JsonMap>();
      const items = (result.results ?? []).map((row) => ({ ...row, sortOrder: Number(row.sortOrder), active: Number(row.active) === 1 }));
      return jsonResponse({ sections: [...AOP_SECTIONS], items });
    }

    const id = safeText(url.searchParams.get("id"), 80);
    if (id) {
      const audit = await findAudit(database, actor, id);
      if (!audit) return jsonResponse({ error: NOT_FOUND }, 404);
      const answers = await loadAnswers(database, id);
      return jsonResponse({ audit, answers, summary: buildSummary(answers) });
    }

    const storeFilter = storeOnly(actor) ? " AND company_id=?1 AND status='final'" : "";
    const auditsQuery = database.prepare(`${AUDIT_SELECT} WHERE deleted=0${storeFilter} ORDER BY audit_date DESC, created_at DESC LIMIT 500`);
    const audits = (await (storeFilter ? auditsQuery.bind(actor.companyId) : auditsQuery).all<AuditRow>()).results ?? [];
    // ponytail: nota por seção calculada lendo as respostas de todas as
    // auditorias da lista (~32 por auditoria); agregar no SQL se ficar lento.
    const answersQuery = database.prepare(
      `SELECT ans.audit_id AS auditId, ans.section, ans.answer FROM ops_audit_answers ans
       JOIN ops_audits a ON a.id=ans.audit_id WHERE a.deleted=0${storeFilter.replace(/company_id|status/g, "a.$&")}`,
    );
    const answerRows = (await (storeFilter ? answersQuery.bind(actor.companyId) : answersQuery)
      .all<{ auditId: string; section: string; answer: string }>()).results ?? [];
    const byAudit = new Map<string, { section: string; groupName: string; text: string; answer: string; note: string }[]>();
    for (const row of answerRows) {
      const list = byAudit.get(row.auditId) ?? [];
      list.push({ section: row.section, groupName: "", text: "", answer: row.answer, note: "" });
      byAudit.set(row.auditId, list);
    }
    const companies = await loadCompanies(database);
    return jsonResponse({
      today: recifeDate(),
      companies: storeOnly(actor) ? companies.filter((company) => company.id === actor.companyId) : companies,
      audits: audits.map((audit) => {
        const summary = buildSummary(byAudit.get(audit.id) ?? []);
        return {
          ...audit,
          done: summary.done, answered: summary.answered, total: summary.total, pct: summary.pct,
          sections: summary.sections.map(({ section, pct }) => ({ section, pct })),
        };
      }),
    });
  } catch (error) {
    console.error("Não foi possível carregar a auditoria operacional.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A AUDITORIA OPERACIONAL." }, 500);
  }
}

function parseItem(body: JsonMap) {
  const item = {
    section: safeText(body.section, 40).toLocaleUpperCase("pt-BR"),
    groupName: safeText(body.groupName, 60).toLocaleUpperCase("pt-BR"),
    text: safeText(body.text, 300),
  };
  if (!(AOP_SECTIONS as readonly string[]).includes(item.section)) return { error: "ESCOLHA A SEÇÃO." };
  if (!item.text) return { error: "INFORME O TEXTO DO ITEM." };
  return { item };
}

export async function POST(request: Request) {
  const body = (await request.clone().json().catch(() => ({}))) as JsonMap;
  const isItem = body.kind === "item";
  const checked = writeGuard(request, isItem ? "manage" : "audit",
    isItem ? "VOCÊ NÃO PODE EDITAR OS ITENS." : "VOCÊ NÃO TEM PERMISSÃO PARA FAZER AUDITORIA.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const database = await getD1();
    const now = new Date().toISOString();
    if (isItem) {
      const parsed = parseItem(body);
      if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
      await ensureDefaultItems(database);
      const last = await database.prepare("SELECT MAX(sort_order) AS maxOrder FROM ops_audit_items").first<{ maxOrder: number | null }>();
      const id = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO ops_audit_items (id, section, group_name, text, sort_order, active, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8)`,
        )
        .bind(id, parsed.item.section, parsed.item.groupName, parsed.item.text, (Number(last?.maxOrder) || 0) + 10,
          actor.id, actor.displayName, now)
        .run();
      return jsonResponse({ created: true, id }, 201);
    }

    const companyId = safeText(body.companyId, 80);
    const company = (await loadCompanies(database)).find((item) => item.id === companyId);
    if (!company) return jsonResponse({ error: "ESCOLHA A LOJA." }, 400);
    const today = recifeDate();
    // Toque duplo / mesma loja no mesmo dia: continua o rascunho que já existe.
    const open = await database
      .prepare("SELECT id FROM ops_audits WHERE company_id=?1 AND audit_date=?2 AND status='draft' AND deleted=0 LIMIT 1")
      .bind(companyId, today)
      .first<{ id: string }>();
    if (open) return jsonResponse({ id: open.id, existing: true });

    await ensureDefaultItems(database);
    const items = (await database
      .prepare("SELECT id, section, group_name AS groupName, text, sort_order AS sortOrder FROM ops_audit_items WHERE active=1 ORDER BY sort_order, id")
      .all<{ id: string; section: string; groupName: string; text: string; sortOrder: number }>()).results ?? [];
    if (!items.length) return jsonResponse({ error: "O CHECKLIST NÃO TEM ITENS ATIVOS." }, 409);
    const id = crypto.randomUUID();
    await database.batch([
      database
        .prepare(
          `INSERT INTO ops_audits (id, company_id, company_name, audit_date, auditor_id, auditor_name, status, deleted, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', 0, ?7, ?7)`,
        )
        .bind(id, company.id, company.name, today, actor.id, actor.displayName, now),
      ...items.map((item) =>
        database
          .prepare(
            `INSERT INTO ops_audit_answers (id, audit_id, item_id, section, group_name, text, sort_order, answer, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '')`,
          )
          .bind(crypto.randomUUID(), id, item.id, item.section, item.groupName, item.text, Number(item.sortOrder))),
    ]);
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar a auditoria operacional.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR." }, 500);
  }
}

// Salva a marcação (FEITO / NÃO FEITO) e a observação de um item do rascunho.
export async function PUT(request: Request) {
  const checked = writeGuard(request, "audit", "VOCÊ NÃO TEM PERMISSÃO PARA FAZER AUDITORIA.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const answer = body.status === "" || (AOP_ANSWERS as readonly unknown[]).includes(body.status) ? String(body.status) : null;
    if (answer === null) return jsonResponse({ error: "MARQUE FEITO OU NÃO FEITO." }, 400);
    const database = await getD1();
    const audit = await findAudit(database, actor, safeText(body.id, 80));
    if (!audit) return jsonResponse({ error: NOT_FOUND }, 404);
    if (audit.status !== "draft") return jsonResponse({ error: "AUDITORIA FINALIZADA: SÓ LEITURA." }, 409);
    const now = new Date().toISOString();
    const saved = await database
      .prepare(
        `UPDATE ops_audit_answers SET answer=?1, note=?2, updated_by=?3, updated_by_name=?4, updated_at=?5
         WHERE id=?6 AND audit_id=?7 RETURNING id`,
      )
      .bind(answer, safeText(body.notes, 1000), actor.id, actor.displayName, now, safeText(body.answerId, 80), audit.id)
      .first<{ id: string }>();
    if (!saved) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);
    await database.prepare("UPDATE ops_audits SET updated_at=?1 WHERE id=?2").bind(now, audit.id).run();
    return jsonResponse({ id: audit.id, updated: true, savedAt: now });
  } catch (error) {
    console.error("Não foi possível salvar o item da auditoria.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR." }, 500);
  }
}

export async function PATCH(request: Request) {
  const body = (await request.clone().json().catch(() => ({}))) as JsonMap;
  const isItem = body.kind === "item" || body.kind === "item-order";
  const checked = writeGuard(request, isItem ? "manage" : "audit",
    isItem ? "VOCÊ NÃO PODE EDITAR OS ITENS." : "VOCÊ NÃO TEM PERMISSÃO PARA FINALIZAR A AUDITORIA.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const database = await getD1();
    const now = new Date().toISOString();
    if (body.kind === "item-order") {
      const ids = Array.isArray(body.ids) ? body.ids.map((value) => safeText(value, 80)).filter(Boolean).slice(0, 500) : [];
      if (!ids.length) return jsonResponse({ error: "ORDEM INVÁLIDA." }, 400);
      await database.batch(ids.map((id, index) =>
        database.prepare("UPDATE ops_audit_items SET sort_order=?1, updated_by=?2, updated_by_name=?3, updated_at=?4 WHERE id=?5")
          .bind((index + 1) * 10, actor.id, actor.displayName, now, id)));
      return jsonResponse({ updated: true });
    }
    if (body.kind === "item") {
      const parsed = parseItem(body);
      if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
      const updated = await database
        .prepare(
          `UPDATE ops_audit_items SET section=?1, group_name=?2, text=?3, active=?4, updated_by=?5, updated_by_name=?6, updated_at=?7
           WHERE id=?8 RETURNING id`,
        )
        .bind(parsed.item.section, parsed.item.groupName, parsed.item.text, body.active === false ? 0 : 1,
          actor.id, actor.displayName, now, safeText(body.id, 80))
        .first<{ id: string }>();
      if (!updated) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);
      return jsonResponse({ id: updated.id, updated: true });
    }

    if (body.action !== "FINALIZAR") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const audit = await findAudit(database, actor, safeText(body.id, 80));
    if (!audit) return jsonResponse({ error: NOT_FOUND }, 404);
    if (audit.status !== "draft") return jsonResponse({ error: "AUDITORIA JÁ FINALIZADA." }, 409);
    const summary = buildSummary(await loadAnswers(database, audit.id));
    if (summary.answered < summary.total) {
      return jsonResponse({ error: `RESPONDA TODOS OS ITENS: FALTAM ${summary.total - summary.answered}.` }, 409);
    }
    const finalized = await database
      .prepare(
        `UPDATE ops_audits SET status='final', finalized_by=?1, finalized_by_name=?2, finalized_at=?3, updated_at=?3
         WHERE id=?4 AND status='draft' RETURNING id`,
      )
      .bind(actor.id, actor.displayName, now, audit.id)
      .first<{ id: string }>();
    if (!finalized) return jsonResponse({ error: "AUDITORIA JÁ FINALIZADA." }, 409);
    return jsonResponse({ id: audit.id, finalized: true });
  } catch (error) {
    console.error("Não foi possível alterar a auditoria operacional.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = writeGuard(request, "delete", "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR AUDITORIA.");
  if ("error" in checked) return checked.error;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const deleted = await database
      .prepare("UPDATE ops_audits SET deleted=1, updated_at=?1 WHERE id=?2 AND deleted=0 RETURNING id")
      .bind(new Date().toISOString(), safeText(body.id, 80))
      .first<{ id: string }>();
    if (!deleted) return jsonResponse({ error: NOT_FOUND }, 404);
    return jsonResponse({ id: deleted.id, deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a auditoria operacional.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR." }, 500);
  }
}
