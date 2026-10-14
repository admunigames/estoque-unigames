import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany } from "../../../lib/access-scope";
import { identity as baseIdentity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Assistência > Estoque (permissões estoque_assistencia:view/entrada/baixa/
// manage/delete). Só a assistência acessa: login com loja vinculada não vê
// nem mexe, mesmo com a permissão (decisão do usuário, 14/10/2026).
//   GET                    → itens ativos
//   GET    ?movements=<id> → histórico do item
//   POST   {category, name, quantity, salePriceCents|null}   (manage)
//   PATCH  {id, category, name, salePriceCents|null}         (manage)
//   PUT    {id, kind:"entrada"|"baixa", quantity, osNumber, note} (entrada / baixa)
//   DELETE {id}                                              (delete; deleted=1)

const CATEGORIES = [
  "GABINETE",
  "PLACA MÃE",
  "PROCESSADOR",
  "MEMÓRIA RAM",
  "SSD",
  "PLACA DE VÍDEO",
  "FONTE",
  "COOLER FAN / COOLER BOX",
  "PEÇAS VARIADAS - NOTEBOOK",
] as const;
const MAX_QUANTITY = 100_000;
const MAX_PRICE_CENTS = 100_000_00;
const NOT_FOUND = "ITEM NÃO ENCONTRADO.";

type Actor = ReturnType<typeof baseIdentity> & { companyId: string };

function identity(request: Request): Actor {
  return { ...baseIdentity(request), companyId: safeText(request.headers.get("x-unigames-company-id"), 80) };
}

function can(actor: Actor, action: string) {
  return actor.role === "admin" || actor.permissions.includes(`estoque_assistencia:${action}`);
}

function guard(request: Request, actions: string[], message: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!actions.some((action) => can(actor, action))) return { error: jsonResponse({ error: message }, 403) };
  if (actor.role !== "admin" && hasCompany(actor.companyId)) {
    return { error: jsonResponse({ error: "O ESTOQUE É SÓ DA ASSISTÊNCIA." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

function parseItem(body: JsonMap) {
  const upper = (value: unknown, max: number) => safeText(value, max).toLocaleUpperCase("pt-BR");
  const raw = body.salePriceCents;
  const item = {
    category: upper(body.category, 60),
    name: upper(body.name, 160),
    salePriceCents: raw === null || raw === undefined || raw === "" ? null : Number(raw),
  };
  if (!(CATEGORIES as readonly string[]).includes(item.category)) return { error: "ESCOLHA A CATEGORIA." };
  if (!item.name) return { error: "INFORME O NOME DO ITEM." };
  if (item.salePriceCents !== null && (!Number.isInteger(item.salePriceCents) || item.salePriceCents <= 0 || item.salePriceCents > MAX_PRICE_CENTS)) {
    return { error: "VALOR DE VENDA INVÁLIDO." };
  }
  return { item };
}

function validQuantity(value: unknown, allowZero: boolean) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= (allowZero ? 0 : 1) && quantity <= MAX_QUANTITY ? quantity : null;
}

function movementStatement(database: D1Database, itemId: string, kind: string, quantity: number, balance: number,
  osNumber: string, note: string, actor: Actor, now: string) {
  return database
    .prepare(
      `INSERT INTO assist_stock_movements (id, item_id, kind, quantity, balance_after, os_number, note, created_by, created_by_name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(crypto.randomUUID(), itemId, kind, quantity, balance, osNumber, note, actor.id, actor.displayName, now);
}

export async function GET(request: Request) {
  const checked = guard(request, ["view", "entrada", "baixa", "manage", "delete"], "VOCÊ NÃO TEM ACESSO AO ESTOQUE DA ASSISTÊNCIA.");
  if ("error" in checked) return checked.error;
  try {
    const database = await getD1();
    const itemId = safeText(new URL(request.url).searchParams.get("movements"), 80);
    if (itemId) {
      const result = await database
        .prepare(
          `SELECT id, kind, quantity, balance_after AS balanceAfter, os_number AS osNumber, note,
                  created_by_name AS createdByName, created_at AS createdAt
           FROM assist_stock_movements WHERE item_id=?1 ORDER BY created_at DESC LIMIT 300`,
        )
        .bind(itemId)
        .all<JsonMap>();
      return jsonResponse({ movements: result.results ?? [] });
    }
    const result = await database
      .prepare(
        `SELECT id, category, name, quantity, sale_price_cents AS salePriceCents, updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM assist_stock_items WHERE deleted=0 ORDER BY category, name`,
      )
      .all<JsonMap>();
    const items = (result.results ?? []).map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      salePriceCents: row.salePriceCents === null || row.salePriceCents === undefined ? null : Number(row.salePriceCents),
    }));
    return jsonResponse({ categories: [...CATEGORIES], items });
  } catch (error) {
    console.error("Não foi possível carregar o estoque da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O ESTOQUE." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request, ["manage"], "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR ITEM.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const parsed = parseItem(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const quantity = validQuantity(body.quantity ?? 0, true);
    if (quantity === null) return jsonResponse({ error: "QUANTIDADE INVÁLIDA." }, 400);
    const { item } = parsed;
    const database = await getD1();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [
      database
        .prepare(
          `INSERT INTO assist_stock_items (id, category, name, quantity, sale_price_cents, deleted, source, created_by, created_by_name, created_at,
             updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 0, 'manual', ?6, ?7, ?8, ?6, ?7, ?8)`,
        )
        .bind(id, item.category, item.name, quantity, item.salePriceCents, actor.id, actor.displayName, now),
    ];
    if (quantity) statements.push(movementStatement(database, id, "entrada", quantity, quantity, "", "SALDO INICIAL", actor, now));
    await database.batch(statements);
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o item do estoque.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O ITEM." }, 500);
  }
}

export async function PATCH(request: Request) {
  const checked = guard(request, ["manage"], "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR ITEM.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const parsed = parseItem(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { item } = parsed;
    const database = await getD1();
    const updated = await database
      .prepare(
        `UPDATE assist_stock_items SET category=?1, name=?2, sale_price_cents=?3, updated_by=?4, updated_by_name=?5, updated_at=?6
         WHERE id=?7 AND deleted=0 RETURNING id`,
      )
      .bind(item.category, item.name, item.salePriceCents, actor.id, actor.displayName, new Date().toISOString(), safeText(body.id, 80))
      .first<{ id: string }>();
    if (!updated) return jsonResponse({ error: NOT_FOUND }, 404);
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível editar o item do estoque.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O ITEM." }, 500);
  }
}

// Entrada ou baixa: o saldo muda num UPDATE só (baixa nunca deixa negativo).
export async function PUT(request: Request) {
  const raw = (await request.clone().json().catch(() => ({}))) as JsonMap;
  const kind = raw.kind === "entrada" || raw.kind === "baixa" ? raw.kind : "";
  const checked = guard(request, [kind || "entrada"], kind === "baixa" ? "VOCÊ NÃO TEM PERMISSÃO PARA DAR BAIXA." : "VOCÊ NÃO TEM PERMISSÃO PARA DAR ENTRADA.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    if (!kind) return jsonResponse({ error: "ESCOLHA ENTRADA OU BAIXA." }, 400);
    const quantity = validQuantity(raw.quantity, false);
    if (quantity === null) return jsonResponse({ error: "INFORME UMA QUANTIDADE MAIOR QUE ZERO." }, 400);
    const osNumber = safeText(raw.osNumber, 40).toLocaleUpperCase("pt-BR");
    const note = safeText(raw.note, 500).toLocaleUpperCase("pt-BR");
    const id = safeText(raw.id, 80);
    const database = await getD1();
    const delta = kind === "entrada" ? quantity : -quantity;
    const now = new Date().toISOString();
    // ponytail: saldo e movimento em dois comandos (UPDATE…RETURNING e INSERT);
    // se o INSERT falhar o saldo fica sem a linha do histórico — raro, usar CTE se precisar.
    const row = await database
      .prepare(
        `UPDATE assist_stock_items SET quantity=quantity+?1, updated_by=?2, updated_by_name=?3, updated_at=?4
         WHERE id=?5 AND deleted=0 AND quantity+?1 >= 0 AND quantity+?1 <= ?6 RETURNING quantity`,
      )
      .bind(delta, actor.id, actor.displayName, now, id, MAX_QUANTITY)
      .first<{ quantity: number }>();
    if (!row) {
      const exists = await database.prepare("SELECT quantity FROM assist_stock_items WHERE id=?1 AND deleted=0").bind(id).first<{ quantity: number }>();
      if (!exists) return jsonResponse({ error: NOT_FOUND }, 404);
      return jsonResponse({ error: `ESTOQUE INSUFICIENTE: SÓ HÁ ${Number(exists.quantity)} UNIDADE(S).` }, 409);
    }
    const balance = Number(row.quantity);
    await movementStatement(database, id, kind, quantity, balance, osNumber, note, actor, now).run();
    return jsonResponse({ updated: true, quantity: balance });
  } catch (error) {
    console.error("Não foi possível movimentar o estoque da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MOVIMENTAR O ESTOQUE." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request, ["delete"], "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR ITEM.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const deleted = await database
      .prepare("UPDATE assist_stock_items SET deleted=1, updated_by=?1, updated_by_name=?2, updated_at=?3 WHERE id=?4 AND deleted=0 RETURNING id")
      .bind(actor.id, actor.displayName, new Date().toISOString(), safeText(body.id, 80))
      .first<{ id: string }>();
    if (!deleted) return jsonResponse({ error: NOT_FOUND }, 404);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o item do estoque.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ITEM." }, 500);
  }
}
