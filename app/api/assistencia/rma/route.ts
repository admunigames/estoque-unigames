import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  newRmaCode,
  recifeDate,
  rmaAlerts,
  RMA_FINAL_STATUS,
  RMA_PRIORITIES,
  RMA_SOLUTION_TYPES,
  RMA_STATUSES,
} from "../../../lib/rma";
import {
  can,
  canView,
  dateOrEmpty,
  findCase,
  identity,
  isStoreLogin,
  jsonResponse,
  loadCompanies,
  NOT_FOUND,
  safeText,
  storeScope,
  upper,
  writeGuard,
  type Actor,
  type Database,
  type JsonMap,
} from "./shared";

// Assistência > RMA — casos e linha do tempo (ver ./shared.ts para as regras
// de acesso). Créditos, descartes e fornecedores ficam em ./cadastros.
//   GET                → lista (escopo de loja) + alertas
//   GET ?id=<id>       → RMA + atualizações + anexos + O.S. ligada
//   POST   {...campos}                 → novo RMA (rma:create)
//   PATCH  {id, ...campos}             → edita (rma:edit)
//   PUT    {id, description, newStatus?, responsible, nextAction?, nextUpdateDate?,
//           solutionType?, solutionDescription?} → nova atualização (rma:edit);
//           newStatus FINALIZADO pede o tipo de solução e finaliza o RMA
//   PATCH  {action:"edit_update"|"delete_update", updateId, ...} → (rma:edit)
//   DELETE {id}                        → exclui (deleted=1; rma:delete)

const CASE_COLUMNS = `id, code, arrival_date AS arrivalDate, store_id AS storeId, store_name AS storeName, supplier,
  responsible, status, priority, os_number AS osNumber, os_deadline AS osDeadline, os_situation AS osSituation,
  invoice_number AS invoiceNumber, accessories, product_name AS productName, product_category AS productCategory,
  brand, serial_number AS serialNumber, quantity, product_notes AS productNotes, defect_type AS defectType,
  defect_description AS defectDescription, technical_analysis AS technicalAnalysis, finalized,
  finalized_at AS finalizedAt, finalized_by_name AS finalizedByName, solution_type AS solutionType,
  solution_description AS solutionDescription, last_update_at AS lastUpdateAt, next_update_date AS nextUpdateDate,
  next_action AS nextAction, source, created_by_name AS createdByName, created_at AS createdAt,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

type CaseInput = {
  arrivalDate: string; storeId: string; supplier: string; responsible: string; status: string; priority: string;
  osNumber: string; osDeadline: string; osSituation: string; invoiceNumber: string; accessories: string;
  productName: string; productCategory: string; brand: string; serialNumber: string; quantity: number;
  productNotes: string; defectType: string; defectDescription: string; technicalAnalysis: string;
};

function parseCase(body: JsonMap): { error: string } | { input: CaseInput } {
  const quantity = Number(body.quantity ?? 1);
  const input: CaseInput = {
    arrivalDate: dateOrEmpty(body.arrivalDate),
    storeId: safeText(body.storeId, 80),
    supplier: upper(body.supplier, 120),
    responsible: upper(body.responsible, 80),
    status: upper(body.status, 60) || "RECEBIDO",
    priority: upper(body.priority, 20),
    osNumber: upper(body.osNumber, 40),
    osDeadline: dateOrEmpty(body.osDeadline),
    osSituation: upper(body.osSituation, 120),
    invoiceNumber: upper(body.invoiceNumber, 60),
    accessories: upper(body.accessories, 500),
    productName: upper(body.productName, 200),
    productCategory: upper(body.productCategory, 60),
    brand: upper(body.brand, 80),
    serialNumber: upper(body.serialNumber, 120),
    quantity,
    productNotes: upper(body.productNotes, 2000),
    defectType: upper(body.defectType, 80),
    defectDescription: upper(body.defectDescription, 2000),
    technicalAnalysis: upper(body.technicalAnalysis, 2000),
  };
  if (!input.arrivalDate) return { error: "INFORME A DATA DE CHEGADA." };
  if (!input.productName) return { error: "INFORME O PRODUTO." };
  if (!input.supplier) return { error: "INFORME O FORNECEDOR." };
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return { error: "QUANTIDADE INVÁLIDA." };
  if (!(RMA_STATUSES as readonly string[]).includes(input.status)) return { error: "STATUS INVÁLIDO." };
  if (input.priority && !(RMA_PRIORITIES as readonly string[]).includes(input.priority)) return { error: "PRIORIDADE INVÁLIDA." };
  if (input.status === RMA_FINAL_STATUS) return { error: "PARA FINALIZAR, REGISTRE UMA ATUALIZAÇÃO COM O STATUS FINALIZADO." };
  return { input };
}

async function storeFor(database: Database, storeId: string) {
  if (!storeId) return { id: "", name: "" };
  return (await loadCompanies(database)).find((company) => company.id === storeId) || null;
}

/** Linha do tempo com os anexos de cada atualização. */
async function loadUpdates(database: Database, rmaId: string) {
  const [updates, attachments] = await Promise.all([
    database
      .prepare(
        `SELECT id, update_at AS updateAt, responsible, description, new_status AS newStatus, next_action AS nextAction,
                next_update_date AS nextUpdateDate, created_by_name AS createdByName, updated_by_name AS updatedByName,
                updated_at AS updatedAt
         FROM rma_updates WHERE rma_id=?1 AND deleted=0 ORDER BY update_at DESC`,
      )
      .bind(rmaId)
      .all<JsonMap>(),
    database
      .prepare(
        `SELECT id, owner_type AS ownerType, owner_id AS ownerId, file_name AS fileName, size_bytes AS sizeBytes,
                uploaded_by_name AS uploadedByName, uploaded_at AS uploadedAt
         FROM rma_attachments WHERE rma_id=?1 AND deleted=0 ORDER BY uploaded_at`,
      )
      .bind(rmaId)
      .all<JsonMap>(),
  ]);
  const files = attachments.results ?? [];
  return {
    updates: (updates.results ?? []).map((update) => ({ ...update, attachments: files.filter((file) => file.ownerType === "update" && file.ownerId === update.id) })),
    attachments: files.filter((file) => file.ownerType === "rma"),
  };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AO RMA." }, 403);
  const scope = storeScope(actor);
  if (scope.blocked) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const url = new URL(request.url);
  const today = recifeDate();
  try {
    const database = await getD1();
    const id = safeText(url.searchParams.get("id"), 80);
    if (id) {
      const found = await findCase(database, actor, id);
      if (!found) return jsonResponse({ error: NOT_FOUND }, 404);
      const row = await database.prepare(`SELECT ${CASE_COLUMNS} FROM rma_cases WHERE id=?1`).bind(id).first<JsonMap>();
      const { updates, attachments } = await loadUpdates(database, id);
      const osNumber = String(row?.osNumber || "");
      const os = osNumber
        ? await database
          .prepare(
            `SELECT id, os_number AS osNumber, category, equipment, status, store_name AS storeName, deadline, closed
             FROM assist_service_orders WHERE canceled=0 AND os_number=?1 ORDER BY closed, created_at DESC`,
          )
          .bind(osNumber)
          .first<JsonMap>()
        : null;
      // Loja não vê custos: descartes e créditos só para quem tem rma:finance.
      const finance = can(actor, "finance") && !isStoreLogin(actor);
      const [disposals, credits] = finance
        ? await Promise.all([
          database
            .prepare(`SELECT id, quantity, unit_cost_cents AS unitCostCents, total_cost_cents AS totalCostCents, reason,
                             authorized_by AS authorizedBy, disposal_date AS disposalDate, notes
                      FROM rma_disposals WHERE rma_id=?1 AND deleted=0 ORDER BY disposal_date DESC`)
            .bind(id)
            .all<JsonMap>(),
          database
            .prepare(`SELECT id, supplier, credit_cents AS creditCents, used_cents AS usedCents, status, generated_date AS generatedDate
                      FROM rma_credits WHERE rma_id=?1 AND deleted=0`)
            .bind(id)
            .all<JsonMap>(),
        ])
        : [null, null];
      const rma = { ...row, alerts: rmaAlerts(row as never, today) };
      return jsonResponse({
        today, rma, updates, attachments, os,
        disposals: disposals?.results ?? [], credits: credits?.results ?? [],
      });
    }

    const filter = scope.allStores ? "" : " AND store_id=?1";
    const statement = database.prepare(`SELECT ${CASE_COLUMNS} FROM rma_cases WHERE deleted=0${filter} ORDER BY arrival_date DESC, created_at DESC`);
    const [result, companies] = await Promise.all([
      (scope.allStores ? statement : statement.bind(actor.companyId)).all<JsonMap>(),
      loadCompanies(database),
    ]);
    const cases = (result.results ?? []).map((row) => ({ ...row, alerts: rmaAlerts(row as never, today) }));
    return jsonResponse({
      today,
      allStores: scope.allStores,
      readOnly: isStoreLogin(actor),
      companies: scope.allStores ? companies : companies.filter((company) => company.id === actor.companyId),
      cases,
    });
  } catch (error) {
    console.error("Não foi possível carregar o RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RMA." }, 500);
  }
}

export async function POST(request: Request) {
  const guard = writeGuard(request, "create", "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR RMA.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const parsed = parseCase(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { input } = parsed;
    const database = await getD1();
    const store = await storeFor(database, input.storeId);
    if (!store) return jsonResponse({ error: "LOJA INVÁLIDA." }, 400);
    const id = crypto.randomUUID();
    const code = newRmaCode();
    const now = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `INSERT INTO rma_cases
            (id, code, arrival_date, store_id, store_name, supplier, responsible, status, priority, os_number, os_deadline,
             os_situation, invoice_number, accessories, product_name, product_category, brand, serial_number, quantity,
             product_notes, defect_type, defect_description, technical_analysis, last_update_at, source,
             created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
                   'manual', ?25, ?26, ?24)`,
        )
        .bind(id, code, input.arrivalDate, store.id, store.name, input.supplier, input.responsible, input.status,
          input.priority, input.osNumber, input.osDeadline, input.osSituation, input.invoiceNumber, input.accessories,
          input.productName, input.productCategory, input.brand, input.serialNumber, input.quantity, input.productNotes,
          input.defectType, input.defectDescription, input.technicalAnalysis, now, actor.id, actor.displayName),
      insertUpdate(database, id, actor, now, {
        responsible: input.responsible || actor.displayName, description: "RMA CADASTRADO", newStatus: input.status,
      }),
    ]);
    return jsonResponse({ created: true, id, code }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O RMA." }, 500);
  }
}

function insertUpdate(
  database: Database, rmaId: string, actor: Actor, now: string,
  entry: { responsible: string; description: string; newStatus?: string; nextAction?: string; nextUpdateDate?: string },
  id: string = crypto.randomUUID(),
) {
  return database
    .prepare(
      `INSERT INTO rma_updates (id, rma_id, update_at, responsible, description, new_status, next_action, next_update_date,
                                created_by, created_by_name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?3)`,
    )
    .bind(id, rmaId, now, entry.responsible, entry.description, entry.newStatus || "", entry.nextAction || "",
      entry.nextUpdateDate || "", actor.id, actor.displayName);
}

async function editOrDeleteUpdate(request: Request, body: JsonMap) {
  const guard = writeGuard(request, "edit", "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR ATUALIZAÇÕES.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  const database = await getD1();
  const updateId = safeText(body.updateId, 80);
  const update = updateId
    ? await database.prepare("SELECT rma_id AS rmaId FROM rma_updates WHERE id=?1 AND deleted=0").bind(updateId).first<{ rmaId: string }>()
    : null;
  if (!update || !(await findCase(database, actor, update.rmaId))) return jsonResponse({ error: "ATUALIZAÇÃO NÃO ENCONTRADA." }, 404);
  const now = new Date().toISOString();
  if (body.action === "delete_update") {
    await database
      .prepare("UPDATE rma_updates SET deleted=1, updated_by_name=?1, updated_at=?2 WHERE id=?3")
      .bind(actor.displayName, now, updateId)
      .run();
    return jsonResponse({ deleted: true });
  }
  const description = upper(body.description, 4000);
  if (!description) return jsonResponse({ error: "ESCREVA A DESCRIÇÃO." }, 400);
  await database
    .prepare(
      `UPDATE rma_updates SET description=?1, responsible=?2, next_action=?3, next_update_date=?4, updated_by_name=?5, updated_at=?6
       WHERE id=?7`,
    )
    .bind(description, upper(body.responsible, 80), upper(body.nextAction, 500), dateOrEmpty(body.nextUpdateDate),
      actor.displayName, now, updateId)
    .run();
  return jsonResponse({ updated: true });
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.clone().json().catch(() => ({}))) as JsonMap;
    if (body.action === "edit_update" || body.action === "delete_update") return await editOrDeleteUpdate(request, body);
    const guard = writeGuard(request, "edit", "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR RMA.");
    if ("error" in guard) return guard.error;
    const { actor } = guard;
    const database = await getD1();
    const existing = await findCase(database, actor, safeText(body.id, 80));
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    // Finalizado mantém o status pela edição (reabrir = atualização com outro status).
    const parsed = parseCase({ ...body, status: existing.finalized ? "RECEBIDO" : body.status });
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const { input } = parsed;
    const status = existing.finalized ? existing.status : input.status;
    const store = await storeFor(database, input.storeId);
    if (!store) return jsonResponse({ error: "LOJA INVÁLIDA." }, 400);
    const now = new Date().toISOString();
    const statements = [
      database
        .prepare(
          `UPDATE rma_cases SET arrival_date=?1, store_id=?2, store_name=?3, supplier=?4, responsible=?5, status=?6, priority=?7,
             os_number=?8, os_deadline=?9, os_situation=?10, invoice_number=?11, accessories=?12, product_name=?13,
             product_category=?14, brand=?15, serial_number=?16, quantity=?17, product_notes=?18, defect_type=?19,
             defect_description=?20, technical_analysis=?21, updated_by_name=?22, updated_at=?23
           WHERE id=?24`,
        )
        .bind(input.arrivalDate, store.id, store.name, input.supplier, input.responsible, status, input.priority,
          input.osNumber, input.osDeadline, input.osSituation, input.invoiceNumber, input.accessories, input.productName,
          input.productCategory, input.brand, input.serialNumber, input.quantity, input.productNotes, input.defectType,
          input.defectDescription, input.technicalAnalysis, actor.displayName, now, existing.id),
    ];
    if (status !== existing.status) {
      statements.push(insertUpdate(database, existing.id, actor, now, { responsible: actor.displayName, description: `STATUS ALTERADO NA EDIÇÃO`, newStatus: status }));
    }
    await database.batch(statements);
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível editar o RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O RMA." }, 500);
  }
}

export async function PUT(request: Request) {
  const guard = writeGuard(request, "edit", "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR RMA.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const description = upper(body.description, 4000);
    const responsible = upper(body.responsible, 80);
    const newStatus = upper(body.newStatus, 60);
    if (!responsible) return jsonResponse({ error: "INFORME O RESPONSÁVEL." }, 400);
    if (!description) return jsonResponse({ error: "ESCREVA A DESCRIÇÃO DA ATUALIZAÇÃO." }, 400);
    if (newStatus && !(RMA_STATUSES as readonly string[]).includes(newStatus)) return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);
    const finalizing = newStatus === RMA_FINAL_STATUS;
    const solutionType = upper(body.solutionType, 60);
    if (finalizing && !(RMA_SOLUTION_TYPES as readonly string[]).includes(solutionType)) {
      return jsonResponse({ error: "ESCOLHA O TIPO DE SOLUÇÃO PARA FINALIZAR." }, 400);
    }
    const database = await getD1();
    const existing = await findCase(database, actor, safeText(body.id, 80));
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    const now = new Date().toISOString();
    const updateId = crypto.randomUUID();
    const nextAction = upper(body.nextAction, 500);
    const nextUpdateDate = dateOrEmpty(body.nextUpdateDate);
    const status = newStatus || existing.status;
    const reopening = Boolean(existing.finalized) && Boolean(newStatus) && !finalizing;
    await database.batch([
      insertUpdate(database, existing.id, actor, now, { responsible, description, newStatus, nextAction, nextUpdateDate }, updateId),
      finalizing
        ? database
          .prepare(
            `UPDATE rma_cases SET status=?1, finalized=1, finalized_at=?2, finalized_by_name=?3, solution_type=?4,
               solution_description=?5, last_update_at=?2, next_update_date='', next_action='' WHERE id=?6`,
          )
          .bind(status, now, responsible, solutionType, upper(body.solutionDescription, 2000), existing.id)
        : database
          .prepare(
            `UPDATE rma_cases SET status=?1, last_update_at=?2, next_update_date=?3, next_action=?4${reopening ? ", finalized=0, finalized_at='', finalized_by_name=''" : ""}
             WHERE id=?5`,
          )
          .bind(status, now, nextUpdateDate, nextAction, existing.id),
    ]);
    return jsonResponse({ updated: true, updateId, finalized: finalizing }, 201);
  } catch (error) {
    console.error("Não foi possível registrar a atualização do RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A ATUALIZAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const guard = writeGuard(request, "delete", "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR RMA.");
  if ("error" in guard) return guard.error;
  const { actor } = guard;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const database = await getD1();
    const existing = await findCase(database, actor, safeText(body.id, 80));
    if (!existing) return jsonResponse({ error: NOT_FOUND }, 404);
    await database
      .prepare("UPDATE rma_cases SET deleted=1, updated_by_name=?1, updated_at=?2 WHERE id=?3")
      .bind(actor.displayName, new Date().toISOString(), existing.id)
      .run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o RMA.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O RMA." }, 500);
  }
}
