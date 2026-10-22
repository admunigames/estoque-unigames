import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canActOnStore, NO_COMPANY_ERROR, resolveStoreScope } from "../../lib/access-scope";
import { identity } from "../commercial/shared";
import { jsonResponse, loadCompanyList, safeText, sameOrigin, type JsonMap } from "../finance/shared";

// INFORMAÇÕES GERAIS (Cadastros, pedido do Douglas — 22/10/2026): por loja,
// INTERNET (provedor, plano, contrato/ID, telefone de suporte), PRESTADORES
// (nome, serviço, telefone/WhatsApp, observação) e OUTROS (texto livre).
// Permissões próprias info_gerais:view/create/edit/delete (worker/index.ts
// MODULE_VIEW_PERMISSIONS.infoGerais). Login com loja vê e mexe só na própria
// loja (app/lib/access-scope.ts). Nenhum campo de senha (Wi-Fi/roteador) —
// decisão do usuário.

type Actor = ReturnType<typeof identity>;
type Action = "view" | "create" | "edit" | "delete";

const KINDS = ["internet", "prestador", "outros"] as const;
type Kind = (typeof KINDS)[number];

const COLUMNS = `id, company_id AS companyId, company_name AS companyName, kind, position, title, service, contract, phone, notes,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

function can(actor: Actor, action: Action) {
  if (actor.role === "admin") return true;
  if (action === "view") return actor.permissions.some((permission) => permission.startsWith("info_gerais:"));
  return actor.permissions.includes(`info_gerais:${action}`);
}

function actorName(actor: Actor) {
  return actor.displayName || actor.id;
}

/** Campos do item pelo tipo (os que não se aplicam ficam vazios). */
function parseItem(body: JsonMap): { error: string } | { kind: Kind; title: string; service: string; contract: string; phone: string; notes: string } {
  const kind = safeText(body.kind, 20) as Kind;
  if (!KINDS.includes(kind)) return { error: "ESCOLHA O TIPO: INTERNET, PRESTADOR OU OUTROS." };
  const item = {
    kind,
    title: safeText(body.title, 160),
    service: kind === "outros" ? "" : safeText(body.service, 160),
    contract: kind === "internet" ? safeText(body.contract, 120) : "",
    phone: kind === "outros" ? "" : safeText(body.phone, 60),
    notes: safeText(body.notes, 2000),
  };
  if (kind === "internet" && !item.title) return { error: "INFORME O PROVEDOR DE INTERNET." };
  if (kind === "prestador" && !item.title) return { error: "INFORME O NOME DO PRESTADOR." };
  if (kind === "outros" && !item.notes) return { error: "ESCREVA A INFORMAÇÃO." };
  return item;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "view")) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER AS INFORMAÇÕES GERAIS." }, 403);
  const scope = resolveStoreScope(actor, "info_gerais:view");
  if (scope.blocked) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  try {
    const database = await getD1();
    const rows = scope.allStores
      ? await database.prepare(`SELECT ${COLUMNS} FROM info_gerais_items ORDER BY company_name, kind, position, created_at`).all()
      : await database
          .prepare(`SELECT ${COLUMNS} FROM info_gerais_items WHERE company_id=?1 ORDER BY kind, position, created_at`)
          .bind(actor.companyId)
          .all();
    const companies = (await loadCompanyList(database)).filter((company) => scope.allStores || company.id === actor.companyId);
    return jsonResponse({
      items: rows.results ?? [],
      companies: companies.map((company) => ({ id: company.id, name: company.name })),
      allStores: scope.allStores,
      can: { create: can(actor, "create"), edit: can(actor, "edit"), delete: can(actor, "delete") },
    });
  } catch (error) {
    console.error("Não foi possível carregar as informações gerais.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS INFORMAÇÕES GERAIS." }, 500);
  }
}

async function loadItem(database: Awaited<ReturnType<typeof getD1>>, id: string) {
  return database
    .prepare("SELECT id, company_id AS companyId, kind, position FROM info_gerais_items WHERE id=?1")
    .bind(id)
    .first<{ id: string; companyId: string; kind: Kind; position: number }>();
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "create")) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR INFORMAÇÕES GERAIS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const companyId = safeText(body.companyId, 80);
    if (!canActOnStore(actor, "info_gerais:create", companyId)) return jsonResponse({ error: "VOCÊ SÓ PODE CADASTRAR NA PRÓPRIA LOJA." }, 403);
    const item = parseItem(body);
    if ("error" in item) return jsonResponse({ error: item.error }, 400);
    const database = await getD1();
    const company = (await loadCompanyList(database)).find((row) => row.id === companyId);
    if (!company) return jsonResponse({ error: "ESCOLHA A LOJA." }, 400);
    const last = await database
      .prepare("SELECT COALESCE(MAX(position), 0) AS position FROM info_gerais_items WHERE company_id=?1 AND kind=?2")
      .bind(companyId, item.kind)
      .first<{ position: number }>();
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO info_gerais_items
          (id, company_id, company_name, kind, position, title, service, contract, phone, notes,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, CURRENT_TIMESTAMP, ?11, ?12, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id, companyId, company.name, item.kind, Number(last?.position ?? 0) + 1, item.title, item.service, item.contract,
        item.phone, item.notes, actor.id, actorName(actor),
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a informação geral.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A INFORMAÇÃO." }, 500);
  }
}

/** PATCH ?id — edita os campos ({ ...campos }) ou muda a ordem ({ move: 'up' | 'down' }). */
export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "edit")) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR INFORMAÇÕES GERAIS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const id = safeText(new URL(request.url).searchParams.get("id"), 80);
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const existing = await loadItem(database, id);
    if (!existing || !canActOnStore(actor, "info_gerais:edit", existing.companyId)) {
      return jsonResponse({ error: "INFORMAÇÃO NÃO ENCONTRADA." }, 404);
    }
    const move = safeText(body.move, 10);
    if (move === "up" || move === "down") {
      const neighbor = await database
        .prepare(
          move === "up"
            ? `SELECT id, position FROM info_gerais_items WHERE company_id=?1 AND kind=?2 AND position < ?3 ORDER BY position DESC LIMIT 1`
            : `SELECT id, position FROM info_gerais_items WHERE company_id=?1 AND kind=?2 AND position > ?3 ORDER BY position ASC LIMIT 1`,
        )
        .bind(existing.companyId, existing.kind, existing.position)
        .first<{ id: string; position: number }>();
      if (neighbor) {
        await database.batch([
          database.prepare("UPDATE info_gerais_items SET position=?1 WHERE id=?2").bind(neighbor.position, existing.id),
          database.prepare("UPDATE info_gerais_items SET position=?1 WHERE id=?2").bind(existing.position, neighbor.id),
        ]);
      }
      return jsonResponse({ moved: Boolean(neighbor) });
    }
    const item = parseItem({ ...body, kind: existing.kind });
    if ("error" in item) return jsonResponse({ error: item.error }, 400);
    await database
      .prepare(
        `UPDATE info_gerais_items SET title=?1, service=?2, contract=?3, phone=?4, notes=?5,
                updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP WHERE id=?8`,
      )
      .bind(item.title, item.service, item.contract, item.phone, item.notes, actor.id, actorName(actor), existing.id)
      .run();
    return jsonResponse({ updated: true, id: existing.id });
  } catch (error) {
    console.error("Não foi possível editar a informação geral.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A INFORMAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "delete")) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR INFORMAÇÕES GERAIS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const id = safeText(new URL(request.url).searchParams.get("id"), 80);
    const database = await getD1();
    const existing = await loadItem(database, id);
    if (!existing || !canActOnStore(actor, "info_gerais:delete", existing.companyId)) {
      return jsonResponse({ error: "INFORMAÇÃO NÃO ENCONTRADA." }, 404);
    }
    await database.prepare("DELETE FROM info_gerais_items WHERE id=?1").bind(existing.id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a informação geral.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A INFORMAÇÃO." }, 500);
  }
}
