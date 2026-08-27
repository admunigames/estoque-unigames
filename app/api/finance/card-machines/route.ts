import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { isMachineStatus, normalizeSerial, validateMachineDraft } from "../../../lib/card-machines";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Maquinetas (POS) — Financeiro Fase 7. Escopo por loja igual a Recebíveis:
// quem tem loja vinculada só vê/gerencia as maquinetas da própria loja; quem
// não tem loja mas tem finance:manage vê todas. Mesma permissão do módulo.

type MachineRow = {
  id: string;
  acquirerId: string;
  acquirerName: string;
  model: string;
  serial: string;
  establishmentCode: string;
  terminal: string;
  companyId: string;
  companyName: string;
  installedAt: string;
  status: string;
  notes: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const params = new URL(request.url).searchParams;
  const companyId = safeText(params.get("companyId"), 80);
  const acquirerId = safeText(params.get("acquirerId"), 80);
  const status = safeText(params.get("status"), 20);

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (!allStores) {
      values.push(scopeActor.companyId);
      conditions.push(`company_id=?${values.length}`);
    } else if (companyId) {
      values.push(companyId);
      conditions.push(`company_id=?${values.length}`);
    }
    if (acquirerId) {
      values.push(acquirerId);
      conditions.push(`acquirer_id=?${values.length}`);
    }
    if (isMachineStatus(status)) {
      values.push(status);
      conditions.push(`status=?${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(
        `SELECT id, acquirer_id AS acquirerId, acquirer_name AS acquirerName, model, serial,
                establishment_code AS establishmentCode, terminal,
                company_id AS companyId, company_name AS companyName,
                installed_at AS installedAt, status, notes,
                created_by_name AS createdByName, created_at AS createdAt, updated_at AS updatedAt
         FROM finance_card_machines
         ${where}
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'inactive' THEN 1 WHEN 'transferred' THEN 2 ELSE 3 END ASC,
           lower(acquirer_name) ASC, lower(model) ASC`,
      )
      .bind(...values)
      .all<MachineRow>();
    return jsonResponse({ machines: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as maquinetas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS MAQUINETAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR MAQUINETAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const acquirerId = safeText(body.acquirerId, 80);
    const model = safeText(body.model, 120);
    const serial = normalizeSerial(body.serial);
    const establishmentCode = safeText(body.establishmentCode, 60);
    const terminal = safeText(body.terminal, 60);
    const installedAt = safeText(body.installedAt, 10);
    const notes = safeText(body.notes, 1000);
    const status = isMachineStatus(body.status) ? body.status : "active";

    let companyId = safeText(body.companyId, 80);
    if (!allStores) companyId = scopeActor.companyId;

    const draftError = validateMachineDraft({ acquirerId, companyId, installedAt });
    if (draftError) return jsonResponse({ error: draftError }, 400);
    if (allStores && !hasCompany(companyId)) {
      return jsonResponse({ error: "SELECIONE A UNIDADE." }, 400);
    }

    const database = await getD1();
    const acquirer = await database
      .prepare("SELECT name, company_id AS companyId FROM finance_acquirers WHERE id=?1")
      .bind(acquirerId)
      .first<{ name: string; companyId: string }>();
    if (!acquirer) return jsonResponse({ error: "ADQUIRENTE NÃO ENCONTRADA." }, 400);
    if (acquirer.companyId && acquirer.companyId !== companyId) {
      return jsonResponse({ error: "ESSA ADQUIRENTE É DE OUTRA UNIDADE." }, 400);
    }

    const companies = await loadCompanyList(database);
    const companyName = companies.find((row) => row.id === companyId)?.name ?? "";
    if (!companyName) return jsonResponse({ error: "UNIDADE NÃO ENCONTRADA." }, 400);

    if (serial) {
      const dupSerial = await database
        .prepare("SELECT id FROM finance_card_machines WHERE serial=?1 AND id<>?2")
        .bind(serial, editId || "")
        .first<{ id: string }>();
      if (dupSerial) return jsonResponse({ error: "JÁ EXISTE UMA MAQUINETA COM ESSE SERIAL." }, 409);
    }

    const who = actor.displayName || "Administrador";
    if (editId) {
      const existing = await database
        .prepare("SELECT company_id AS companyId FROM finance_card_machines WHERE id=?1")
        .bind(editId)
        .first<{ companyId: string }>();
      if (!existing) return jsonResponse({ error: "MAQUINETA NÃO ENCONTRADA." }, 404);
      if (!allStores && existing.companyId !== scopeActor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO PODE EDITAR ESTA MAQUINETA." }, 403);
      }
      await database
        .prepare(
          `UPDATE finance_card_machines
           SET acquirer_id=?1, acquirer_name=?2, model=?3, serial=?4, establishment_code=?5,
               terminal=?6, company_id=?7, company_name=?8, installed_at=?9, status=?10, notes=?11,
               updated_by=?12, updated_by_name=?13, updated_at=now()::text
           WHERE id=?14`,
        )
        .bind(
          acquirerId,
          acquirer.name,
          model,
          serial,
          establishmentCode,
          terminal,
          companyId,
          companyName,
          installedAt,
          status,
          notes,
          actor.id,
          who,
          editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_card_machines
          (id, acquirer_id, acquirer_name, model, serial, establishment_code, terminal,
           company_id, company_name, installed_at, status, notes,
           created_by, created_by_name, updated_by, updated_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?13, ?14)`,
      )
      .bind(
        id,
        acquirerId,
        acquirer.name,
        model,
        serial,
        establishmentCode,
        terminal,
        companyId,
        companyName,
        installedAt,
        status,
        notes,
        actor.id,
        who,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a maquineta.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A MAQUINETA." }, 500);
  }
}
