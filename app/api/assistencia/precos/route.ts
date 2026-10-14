import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany } from "../../../lib/access-scope";
import { identity as baseIdentity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Assistência > Consulta de Preços (permissões precos_assistencia:view/
// create/edit/delete). A tabela é a mesma para todas as lojas: qualquer
// login com a permissão consulta; só a assistência (login SEM loja) altera
// — login com loja vinculada nunca grava, mesmo com a permissão (decisão do
// usuário, 14/10/2026).
//   GET                               → todos os preços ativos
//   POST   {service, brand, model, priceCents|null}
//   PATCH  {id, service, brand, model, priceCents|null}
//   DELETE {id}                       → deleted=1

const PRICE_SERVICES = [
  "DISPLAY / TELA FRONTAL",
  "TAMPA / VIDRO TRASEIRO",
  "CONECTOR / DOC DE CARGA",
  "BATERIA",
] as const;
const MAX_PRICE_CENTS = 100_000_00; // R$ 100 mil — teto de sanidade.
const NOT_FOUND = "PREÇO NÃO ENCONTRADO.";

type Actor = ReturnType<typeof baseIdentity> & { companyId: string };

function identity(request: Request): Actor {
  return { ...baseIdentity(request), companyId: safeText(request.headers.get("x-unigames-company-id"), 80) };
}

function can(actor: Actor, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

function writeGuard(request: Request, action: string, message: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!can(actor, `precos_assistencia:${action}`)) return { error: jsonResponse({ error: message }, 403) };
  if (actor.role !== "admin" && hasCompany(actor.companyId)) {
    return { error: jsonResponse({ error: "SÓ A ASSISTÊNCIA ATUALIZA OS PREÇOS." }, 403) };
  }
  if (!sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

function parsePrice(body: JsonMap): { error: string } | { price: { service: string; brand: string; model: string; priceCents: number | null } } {
  const upper = (value: unknown, max: number) => safeText(value, max).toLocaleUpperCase("pt-BR");
  const price = {
    service: upper(body.service, 60),
    brand: upper(body.brand, 60),
    model: upper(body.model, 160),
    priceCents: body.priceCents === null || body.priceCents === undefined || body.priceCents === "" ? null : Number(body.priceCents),
  };
  if (!(PRICE_SERVICES as readonly string[]).includes(price.service)) return { error: "ESCOLHA O SERVIÇO." };
  if (!price.brand) return { error: "INFORME A MARCA." };
  if (!price.model) return { error: "INFORME O MODELO." };
  if (price.priceCents !== null && (!Number.isInteger(price.priceCents) || price.priceCents <= 0 || price.priceCents > MAX_PRICE_CENTS)) {
    return { error: "VALOR INVÁLIDO." };
  }
  return { price };
}

async function findPrice(database: D1Database, id: string) {
  return id
    ? database.prepare("SELECT id FROM assist_repair_prices WHERE id=?1 AND deleted=0").bind(id).first<{ id: string }>()
    : null;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!["view", "create", "edit", "delete"].some((action) => can(actor, `precos_assistencia:${action}`))) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CONSULTA DE PREÇOS." }, 403);
  }
  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, service, brand, model, price_cents AS priceCents, updated_by_name AS updatedByName, updated_at AS updatedAt,
                created_by_name AS createdByName, created_at AS createdAt
         FROM assist_repair_prices WHERE deleted=0 ORDER BY service, brand, model`,
      )
      .all<JsonMap>();
    const prices = (result.results ?? []).map((row) => ({
      ...row,
      priceCents: row.priceCents === null || row.priceCents === undefined ? null : Number(row.priceCents),
    }));
    return jsonResponse({ services: [...PRICE_SERVICES], prices });
  } catch (error) {
    console.error("Não foi possível carregar a consulta de preços.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PREÇOS." }, 500);
  }
}

export async function POST(request: Request) {
  const guard = writeGuard(request, "create", "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR PREÇO.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const parsed = parsePrice((await request.json().catch(() => ({}))) as JsonMap);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { price } = parsed;
    const database = await getD1();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO assist_repair_prices (id, service, brand, model, price_cents, deleted, source, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 'manual', ?6, ?7, ?8, ?6, ?7, ?8)`,
      )
      .bind(id, price.service, price.brand, price.model, price.priceCents, actor.id, actor.displayName, now)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o preço.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O PREÇO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const guard = writeGuard(request, "edit", "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR PREÇO.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const parsed = parsePrice(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { price } = parsed;
    const database = await getD1();
    const existing = await findPrice(database, safeText(body.id, 80));
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    await database
      .prepare(
        `UPDATE assist_repair_prices SET service=?1, brand=?2, model=?3, price_cents=?4, updated_by=?5, updated_by_name=?6, updated_at=?7
         WHERE id=?8`,
      )
      .bind(price.service, price.brand, price.model, price.priceCents, actor.id, actor.displayName, new Date().toISOString(), existing.id)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível alterar o preço.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ALTERAR O PREÇO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const guard = writeGuard(request, "delete", "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR PREÇO.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const existing = await findPrice(database, safeText(body.id, 80));
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    await database
      .prepare("UPDATE assist_repair_prices SET deleted=1, updated_by=?1, updated_by_name=?2, updated_at=?3 WHERE id=?4")
      .bind(actor.id, actor.displayName, new Date().toISOString(), existing.id)
      .run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o preço.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O PREÇO." }, 500);
  }
}
