import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { parseMoneyCents } from "../../../../lib/rma";
import {
  can,
  canView,
  dateOrEmpty,
  findCase,
  identity,
  isStoreLogin,
  jsonResponse,
  safeText,
  upper,
  writeGuard,
  type Actor,
  type Database,
  type JsonMap,
} from "../shared";

// Assistência > RMA — créditos com fornecedor, descartes e fornecedores.
// Loja não acessa (só a assistência). Fornecedores: quem tem rma:view vê a
// lista (para escolher no RMA); créditos, descartes e cadastro de fornecedor
// pedem rma:finance.
//   GET                                   → {suppliers, credits?, disposals?}
//   POST   {entity, ...campos}            → cria   (entity: credit|disposal|supplier)
//   PATCH  {entity, id, ...campos}        → edita
//   DELETE {entity, id}                   → exclui (deleted=1 / fornecedor inativo)

type Entity = "credit" | "disposal" | "supplier";
const TABLES: Record<Entity, string> = { credit: "rma_credits", disposal: "rma_disposals", supplier: "rma_suppliers" };

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor) || isStoreLogin(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AOS CADASTROS DO RMA." }, 403);
  try {
    const database = await getD1();
    const suppliers = await database
      .prepare(
        `SELECT id, name, contact_name AS contactName, phone, whatsapp, email, cnpj, treatment_model AS treatmentModel,
                notes, active FROM rma_suppliers ORDER BY name`,
      )
      .all<JsonMap>();
    if (!can(actor, "finance")) return jsonResponse({ suppliers: suppliers.results ?? [] });
    const [credits, disposals, credited] = await Promise.all([
      database
        .prepare(
          `SELECT id, supplier, rma_id AS rmaId, rma_code AS rmaCode, generated_date AS generatedDate, credit_cents AS creditCents,
                  used_cents AS usedCents, status, usage_type AS usageType, usage_date AS usageDate,
                  document_number AS documentNumber, notes, created_by_name AS createdByName, updated_by_name AS updatedByName
           FROM rma_credits WHERE deleted=0 ORDER BY generated_date DESC`,
        )
        .all<JsonMap>(),
      database
        .prepare(
          `SELECT id, rma_id AS rmaId, rma_code AS rmaCode, product_name AS productName, product_category AS productCategory,
                  store_id AS storeId, store_name AS storeName, supplier, quantity, unit_cost_cents AS unitCostCents,
                  total_cost_cents AS totalCostCents, reason, authorized_by AS authorizedBy, disposal_date AS disposalDate,
                  notes, created_by_name AS createdByName
           FROM rma_disposals WHERE deleted=0 ORDER BY disposal_date DESC, created_at DESC`,
        )
        .all<JsonMap>(),
      database
        .prepare(
          `SELECT id, owner_id AS ownerId, file_name AS fileName FROM rma_attachments
           WHERE owner_type='credit' AND deleted=0 ORDER BY uploaded_at`,
        )
        .all<JsonMap>(),
    ]);
    const files = credited.results ?? [];
    return jsonResponse({
      suppliers: suppliers.results ?? [],
      credits: (credits.results ?? []).map((credit) => ({ ...credit, attachments: files.filter((file) => file.ownerId === credit.id) })),
      disposals: disposals.results ?? [],
    });
  } catch (error) {
    console.error("Não foi possível carregar os cadastros do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS CADASTROS DO RMA." }, 500);
  }
}

function entityOf(body: JsonMap): Entity | null {
  return body.entity === "credit" || body.entity === "disposal" || body.entity === "supplier" ? body.entity : null;
}

async function parseCredit(database: Database, actor: Actor, body: JsonMap) {
  const credit = parseMoneyCents(body.creditValue);
  const used = parseMoneyCents(body.usedValue ?? 0);
  const supplier = upper(body.supplier, 120);
  if (!supplier) return { error: "INFORME O FORNECEDOR." };
  if (credit === null || credit <= 0) return { error: "INFORME O VALOR DO CRÉDITO." };
  if (used === null || used > credit) return { error: "O VALOR USADO NÃO PODE PASSAR DO CRÉDITO." };
  const rma = body.rmaId ? await findCase(database, actor, safeText(body.rmaId, 80)) : null;
  return {
    values: {
      supplier, rma_id: rma?.id || "", rma_code: rma?.code || "", generated_date: dateOrEmpty(body.generatedDate),
      credit_cents: credit, used_cents: used, status: upper(body.status, 60), usage_type: upper(body.usageType, 60),
      usage_date: dateOrEmpty(body.usageDate), document_number: upper(body.documentNumber, 80), notes: upper(body.notes, 2000),
    },
  };
}

async function parseDisposal(database: Database, actor: Actor, body: JsonMap) {
  const quantity = Number(body.quantity ?? 1);
  const unit = parseMoneyCents(body.unitCost ?? 0);
  if (!Number.isInteger(quantity) || quantity < 1) return { error: "QUANTIDADE INVÁLIDA." };
  if (unit === null) return { error: "CUSTO UNITÁRIO INVÁLIDO." };
  const date = dateOrEmpty(body.disposalDate);
  if (!date) return { error: "INFORME A DATA DO DESCARTE." };
  const rma = body.rmaId ? await findCase(database, actor, safeText(body.rmaId, 80)) : null;
  if (body.rmaId && !rma) return { error: "RMA NÃO ENCONTRADO." };
  const source = rma
    ? await database
      .prepare("SELECT product_name AS productName, product_category AS productCategory, store_id AS storeId, store_name AS storeName, supplier FROM rma_cases WHERE id=?1")
      .bind(rma.id)
      .first<Record<string, string>>()
    : null;
  const productName = upper(body.productName, 200) || source?.productName || "";
  if (!productName) return { error: "INFORME O PRODUTO." };
  return {
    values: {
      rma_id: rma?.id || "", rma_code: rma?.code || "", product_name: productName,
      product_category: upper(body.productCategory, 60) || source?.productCategory || "",
      store_id: source?.storeId || "", store_name: source?.storeName || "",
      supplier: upper(body.supplier, 120) || source?.supplier || "", quantity, unit_cost_cents: unit,
      total_cost_cents: unit * quantity, reason: upper(body.reason, 200), authorized_by: upper(body.authorizedBy, 80),
      disposal_date: date, notes: upper(body.notes, 2000),
    },
  };
}

function parseSupplier(body: JsonMap) {
  const name = upper(body.name, 120);
  if (!name) return { error: "INFORME O NOME DO FORNECEDOR." };
  return {
    values: {
      name, contact_name: upper(body.contactName, 120), phone: safeText(body.phone, 40), whatsapp: safeText(body.whatsapp, 40),
      email: safeText(body.email, 200), cnpj: safeText(body.cnpj, 30), treatment_model: safeText(body.treatmentModel, 2000),
      notes: upper(body.notes, 2000), active: body.active === false || body.active === 0 ? 0 : 1,
    },
  };
}

async function parse(entity: Entity, database: Database, actor: Actor, body: JsonMap): Promise<{ error: string } | { values: Record<string, string | number> }> {
  if (entity === "credit") return parseCredit(database, actor, body);
  if (entity === "disposal") return parseDisposal(database, actor, body);
  return parseSupplier(body);
}

async function write(request: Request, method: "POST" | "PATCH") {
  const body = (await request.clone().json().catch(() => ({}))) as JsonMap;
  const entity = entityOf(body);
  if (!entity) return jsonResponse({ error: "CADASTRO INVÁLIDO." }, 400);
  const guard = writeGuard(request, "finance", "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR CRÉDITOS, DESCARTES E FORNECEDORES.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const database = await getD1();
    const parsed = await parse(entity, database, actor, body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const now = new Date().toISOString();
    const table = TABLES[entity];
    const values = parsed.values;
    const columns = Object.keys(values);
    if (method === "PATCH") {
      const id = safeText(body.id, 80);
      const set = columns.map((column, index) => `${column}=?${index + 1}`).join(", ");
      const audit = entity === "disposal" ? "" : `, updated_by_name=?${columns.length + 1}, updated_at=?${columns.length + 2}`;
      const params: (string | number)[] = [...Object.values(values), ...(audit ? [actor.displayName, now] : []), id];
      const row = await database
        .prepare(`UPDATE ${table} SET ${set}${audit} WHERE id=?${params.length}${entity === "supplier" ? "" : " AND deleted=0"} RETURNING id`)
        .bind(...params)
        .first<{ id: string }>();
      if (!row) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
      return jsonResponse({ updated: true });
    }
    const id = crypto.randomUUID();
    const extra: Record<string, string> = entity === "supplier"
      ? { created_by_name: actor.displayName, created_at: now }
      : { created_by: actor.id, created_by_name: actor.displayName, created_at: now };
    const all = { id, ...values, ...extra };
    const names = Object.keys(all);
    const statements = [
      database
        .prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, index) => `?${index + 1}`).join(", ")})`)
        .bind(...Object.values(all)),
    ];
    // Descarte de um RMA entra na linha do tempo do RMA.
    if (entity === "disposal" && values.rma_id) {
      statements.push(
        database
          .prepare(
            `INSERT INTO rma_updates (id, rma_id, update_at, responsible, description, new_status, created_by, created_by_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?3)`,
          )
          .bind(crypto.randomUUID(), values.rma_id, now, values.authorized_by || actor.displayName,
            `DESCARTE REGISTRADO: ${values.quantity} UN.${values.reason ? ` - ${values.reason}` : ""}`, actor.id, actor.displayName),
      );
    }
    await database.batch(statements);
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o cadastro do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR." }, 500);
  }
}

export const POST = (request: Request) => write(request, "POST");
export const PATCH = (request: Request) => write(request, "PATCH");

export async function DELETE(request: Request) {
  const body = (await request.clone().json().catch(() => ({}))) as JsonMap;
  const entity = entityOf(body);
  if (!entity) return jsonResponse({ error: "CADASTRO INVÁLIDO." }, 400);
  const guard = writeGuard(request, "finance", "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR.");
  if ("error" in guard) return guard.error;
  try {
    const database = await getD1();
    const column = entity === "supplier" ? "active=0" : "deleted=1";
    const row = await database
      .prepare(`UPDATE ${TABLES[entity]} SET ${column} WHERE id=?1 RETURNING id`)
      .bind(safeText(body.id, 80))
      .first<{ id: string }>();
    if (!row) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o cadastro do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR." }, 500);
  }
}
