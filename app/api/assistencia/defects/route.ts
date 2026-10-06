import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { isUniqueViolation, parseDefectValues, parseNewDefect, upper } from "../../../lib/assistencia";
import { canManage, FORBIDDEN, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Tabela de valores da assistência (defeitos por aparelho). Sem excluir: só
// desativar — orçamentos antigos guardam a própria cópia do nome/valor, mas
// manter a linha evita "sumir" um defeito que ainda aparece no histórico.

type DefectRow = {
  id: string;
  category: string;
  device: string;
  name: string;
  minCents: number;
  maxCents: number;
  quoteOnly: number;
  active: number;
  sortOrder: number;
};

// Mão de obra padrão de todo aparelho (migration 0080).
const LABOR_NAME = "MÃO DE OBRA";
const LABOR_CENTS = 9999;

const DEFECT_SELECT = `
  SELECT id, category, device, name, min_cents AS minCents, max_cents AS maxCents,
         quote_only AS quoteOnly, active, sort_order AS sortOrder
  FROM assist_defects`;

function normalizeDefect(row: DefectRow) {
  return {
    id: row.id,
    category: row.category,
    device: row.device,
    name: row.name,
    minCents: Number(row.minCents) || 0,
    maxCents: Number(row.maxCents) || 0,
    quoteOnly: Number(row.quoteOnly) === 1,
    active: Number(row.active) === 1,
    sortOrder: Number(row.sortOrder) || 0,
  };
}

function duplicateMessage(device: string, name: string) {
  return `O DEFEITO ${name} JÁ EXISTE PARA O APARELHO ${device}.`;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  try {
    const database = await getD1();
    const result = await database
      .prepare(`${DEFECT_SELECT} ORDER BY sort_order, device, name`)
      .all<DefectRow>();
    return jsonResponse({ defects: (result.results ?? []).map(normalizeDefect) });
  } catch (error) {
    console.error("Não foi possível carregar a tabela de valores da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A TABELA DE VALORES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  let duplicate = "";
  try {
    const parsed = parseNewDefect((await request.json()) as JsonMap);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const defect = parsed.defect;
    duplicate = duplicateMessage(defect.device, defect.name);
    const database = await getD1();
    const category = await database
      .prepare("SELECT id FROM assist_categories WHERE name=?1 AND active=1 LIMIT 1")
      .bind(defect.category)
      .first<{ id: string }>();
    if (!category) return jsonResponse({ error: `A CATEGORIA ${defect.category} NÃO EXISTE (CADASTRE NA ABA CATEGORIAS).` }, 400);
    // Um aparelho pertence a uma categoria só (é por ela que o orçamento filtra).
    const sameDevice = await database
      .prepare("SELECT category FROM assist_defects WHERE device=?1 LIMIT 1")
      .bind(defect.device)
      .first<{ category: string }>();
    if (sameDevice && sameDevice.category !== defect.category) {
      return jsonResponse({ error: `O APARELHO ${defect.device} JÁ ESTÁ NA CATEGORIA ${sameDevice.category}.` }, 400);
    }
    const existing = await database
      .prepare("SELECT id FROM assist_defects WHERE device=?1 AND name=?2 LIMIT 1")
      .bind(defect.device, defect.name)
      .first<{ id: string }>();
    if (existing) return jsonResponse({ error: duplicate }, 409);
    const order = await database
      .prepare("SELECT MAX(sort_order) AS maxOrder FROM assist_defects")
      .first<{ maxOrder: number | string | null }>();
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const sortOrder = (Number(order?.maxOrder) || 0) + 1;
    const insert = (rowId: string, name: string, minCents: number, maxCents: number, quoteOnly: boolean) =>
      database
        .prepare(
          `INSERT INTO assist_defects
            (id, category, device, name, min_cents, max_cents, quote_only, active, sort_order,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11, ?9, ?10, ?11)`,
        )
        .bind(rowId, defect.category, defect.device, name, minCents, maxCents, quoteOnly ? 1 : 0, sortOrder,
          actor.id, actor.displayName, at);
    const statements = [insert(id, defect.name, defect.minCents, defect.maxCents, defect.quoteOnly)];
    // Aparelho novo já nasce com a MÃO DE OBRA padrão (mesma regra da migration 0080).
    if (!sameDevice && defect.name !== LABOR_NAME) {
      statements.push(insert(crypto.randomUUID(), LABOR_NAME, LABOR_CENTS, LABOR_CENTS, false));
    }
    await database.batch(statements);
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    if (duplicate && isUniqueViolation(error)) return jsonResponse({ error: duplicate }, 409);
    console.error("Não foi possível cadastrar o defeito da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O DEFEITO." }, 500);
  }
}

// Edita nome, valores, "sob orçamento" e ativo de UMA linha (SALVAR por linha).
export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  let duplicate = "";
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const database = await getD1();
    const current = id
      ? await database.prepare(`${DEFECT_SELECT} WHERE id=?1 LIMIT 1`).bind(id).first<DefectRow>()
      : null;
    if (!current) return jsonResponse({ error: "DEFEITO NÃO ENCONTRADO." }, 404);
    const name = upper(safeText(body.name, 160));
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DO DEFEITO." }, 400);
    const values = parseDefectValues(body);
    if ("error" in values) return jsonResponse({ error: values.error }, 400);
    const active = body.active === false || body.active === 0 || body.active === "0" ? 0 : 1;
    duplicate = duplicateMessage(current.device, name);
    const clash = await database
      .prepare("SELECT id FROM assist_defects WHERE device=?1 AND name=?2 AND id<>?3 LIMIT 1")
      .bind(current.device, name, id)
      .first<{ id: string }>();
    if (clash) return jsonResponse({ error: duplicate }, 409);
    await database
      .prepare(
        `UPDATE assist_defects
         SET name=?1, min_cents=?2, max_cents=?3, quote_only=?4, active=?5,
             updated_by=?6, updated_by_name=?7, updated_at=?8
         WHERE id=?9`,
      )
      .bind(
        name,
        values.minCents,
        values.maxCents,
        values.quoteOnly ? 1 : 0,
        active,
        actor.id,
        actor.displayName,
        new Date().toISOString(),
        id,
      )
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    if (duplicate && isUniqueViolation(error)) return jsonResponse({ error: duplicate }, 409);
    console.error("Não foi possível editar o defeito da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O DEFEITO." }, 500);
  }
}
