import { getD1 } from "../../../../../db";
import {
  RMA_LOCKED_OPTIONS,
  RMA_OPTION_CATEGORIES,
  RMA_OPTION_COLUMNS,
  type RmaOptionCategory,
} from "../../../../lib/rma";
import { jsonResponse, loadOptions, safeText, upper, writeGuard, type Actor, type Database, type JsonMap } from "../shared";

// RMA > CONFIGURAÇÕES (permissão rma:config, login sem loja): listas de opções
// no formato do sistema antigo — nome, descrição, cor, ordem e ativo.
// As opções ficam em rma_options; categoria ainda sem linhas é gravada com os
// padrões na primeira alteração. Renomear atualiza os registros que usam o
// nome antigo. Opções usadas pelo código (RMA_LOCKED_OPTIONS) só mudam cor,
// descrição e ordem.
//   POST   {category, name, description, color, sortOrder, active}
//   PATCH  {id, name, description, color, sortOrder, active}
//   DELETE {id}

const COLOR = /^#[0-9a-f]{6}$/i;

function categoryOf(value: unknown): RmaOptionCategory | null {
  return RMA_OPTION_CATEGORIES.some((category) => category.key === value) ? (value as RmaOptionCategory) : null;
}

const locked = (category: string, name: string) => (RMA_LOCKED_OPTIONS[category as RmaOptionCategory] || []).includes(name);

function parse(body: JsonMap, category: RmaOptionCategory) {
  const name = upper(body.name, 80);
  const description = upper(body.description, 300);
  const color = safeText(body.color, 7);
  const sortOrder = Number(body.sortOrder ?? 0);
  if (!name) return { error: "INFORME O NOME DA OPÇÃO." };
  if (color && !COLOR.test(color)) return { error: "COR INVÁLIDA." };
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) return { error: "ORDEM INVÁLIDA." };
  if (category === "alert_days") {
    const days = Number(description);
    if (!Number.isInteger(days) || days < 0 || days > 365) return { error: "INFORME OS DIAS (0 A 365)." };
  }
  return { values: { name, description, color: color.toLowerCase(), sortOrder, active: body.active === false || body.active === 0 || body.active === "0" ? 0 : 1 } };
}

/** Categoria ainda nos padrões: grava os padrões antes da primeira alteração. */
async function materialize(database: Database, category: RmaOptionCategory, actor: Actor, now: string) {
  const saved = await database
    .prepare("SELECT count(*) AS n FROM rma_options WHERE deleted=0 AND category=?1")
    .bind(category)
    .first<{ n: number }>();
  if (Number(saved?.n || 0) > 0) return;
  const { options } = await loadOptions(database);
  await database.batch(options[category].map((option) =>
    database
      .prepare(
        `INSERT INTO rma_options (id, category, name, description, color, sort_order, active, deleted, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8)`,
      )
      .bind(crypto.randomUUID(), category, option.name, option.description, option.color, option.sortOrder, actor.displayName, now)));
}

async function nameTaken(database: Database, category: string, name: string, exceptId: string) {
  return Boolean(await database
    .prepare("SELECT id FROM rma_options WHERE deleted=0 AND category=?1 AND name=?2 AND id<>?3")
    .bind(category, name, exceptId)
    .first<{ id: string }>());
}

export async function POST(request: Request) {
  const guard = writeGuard(request, "config", "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR AS CONFIGURAÇÕES DO RMA.");
  if ("error" in guard) return guard.error;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const category = categoryOf(body.category);
    if (!category) return jsonResponse({ error: "LISTA INVÁLIDA." }, 400);
    if (category === "alert_days") return jsonResponse({ error: "OS PRAZOS DE ALERTA SÃO FIXOS; ALTERE SÓ OS DIAS." }, 400);
    const parsed = parse(body, category);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const database = await getD1();
    const now = new Date().toISOString();
    await materialize(database, category, guard.actor, now);
    const { name, description, color, sortOrder, active } = parsed.values;
    if (await nameTaken(database, category, name, "")) return jsonResponse({ error: `JÁ EXISTE A OPÇÃO ${name}.` }, 409);
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO rma_options (id, category, name, description, color, sort_order, active, deleted, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)`,
      )
      .bind(id, category, name, description, color, sortOrder, active, guard.actor.displayName, now)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar a opção do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A OPÇÃO." }, 500);
  }
}

type Saved = { id: string; category: string; name: string };

/** Opção pelo id; id vazio + categoria + nome = opção padrão (grava os padrões antes). */
async function findOption(database: Database, body: JsonMap, actor: Actor, now: string): Promise<Saved | null> {
  const id = safeText(body.id, 80);
  if (!id) {
    const category = categoryOf(body.category);
    if (!category) return null;
    await materialize(database, category, actor, now);
    return database
      .prepare("SELECT id, category, name FROM rma_options WHERE deleted=0 AND category=?1 AND name=?2")
      .bind(category, upper(body.originalName, 80))
      .first<Saved>();
  }
  return database.prepare("SELECT id, category, name FROM rma_options WHERE id=?1 AND deleted=0").bind(id).first<Saved>();
}

export async function PATCH(request: Request) {
  const guard = writeGuard(request, "config", "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR AS CONFIGURAÇÕES DO RMA.");
  if ("error" in guard) return guard.error;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const now = new Date().toISOString();
    const saved = await findOption(database, body, guard.actor, now);
    if (!saved) return jsonResponse({ error: "OPÇÃO NÃO ENCONTRADA." }, 404);
    const category = saved.category as RmaOptionCategory;
    const parsed = parse(body, category);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { name, description, color, sortOrder, active } = parsed.values;
    if (locked(category, saved.name) && (name !== saved.name || !active)) {
      return jsonResponse({ error: `${saved.name} É USADA PELO SISTEMA: SÓ COR, DESCRIÇÃO E ORDEM PODEM MUDAR.` }, 409);
    }
    if (name !== saved.name && await nameTaken(database, category, name, saved.id)) return jsonResponse({ error: `JÁ EXISTE A OPÇÃO ${name}.` }, 409);
    const statements = [
      database
        .prepare(
          `UPDATE rma_options SET name=?1, description=?2, color=?3, sort_order=?4, active=?5, updated_by_name=?6, updated_at=?7
           WHERE id=?8`,
        )
        .bind(name, description, color, sortOrder, active, guard.actor.displayName, now, saved.id),
    ];
    // Renomear: os registros que usam o nome antigo passam para o novo.
    if (name !== saved.name) {
      for (const [table, column] of RMA_OPTION_COLUMNS[category] || []) {
        statements.push(database.prepare(`UPDATE ${table} SET ${column}=?1 WHERE ${column}=?2`).bind(name, saved.name));
      }
    }
    await database.batch(statements);
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível alterar a opção do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A OPÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const guard = writeGuard(request, "config", "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR AS CONFIGURAÇÕES DO RMA.");
  if ("error" in guard) return guard.error;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const now = new Date().toISOString();
    const saved = await findOption(database, body, guard.actor, now);
    if (!saved) return jsonResponse({ error: "OPÇÃO NÃO ENCONTRADA." }, 404);
    if (locked(saved.category, saved.name)) return jsonResponse({ error: `${saved.name} É USADA PELO SISTEMA E NÃO PODE SER EXCLUÍDA.` }, 409);
    // Os registros antigos mantêm o nome; a opção só sai das listas.
    await database
      .prepare("UPDATE rma_options SET deleted=1, updated_by_name=?1, updated_at=?2 WHERE id=?3")
      .bind(guard.actor.displayName, now, saved.id)
      .run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a opção do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A OPÇÃO." }, 500);
  }
}
