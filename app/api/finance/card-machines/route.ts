import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { isMachineStatus } from "../../../lib/card-machines";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import { insertMachineSql, validateMachineInput } from "./create";

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
    values.push(todayInTimezone());
    const today = `?${values.length}`;
    // feeSource (coluna TAXAS): 'machine' = tem taxa própria vigente,
    // 'acquirer' = usa a da adquirente, 'none' = nenhuma vigente.
    const result = await database
      .prepare(
        `SELECT id, acquirer_id AS acquirerId, acquirer_name AS acquirerName, model, serial, admin_password AS adminPassword,
                establishment_code AS establishmentCode, terminal,
                company_id AS companyId, company_name AS companyName,
                installed_at AS installedAt, status, notes,
                created_by_name AS createdByName, created_at AS createdAt, updated_at AS updatedAt,
                CASE
                  WHEN EXISTS (SELECT 1 FROM finance_card_fees f WHERE f.machine_id = m.id
                               AND (f.valid_to = '' OR f.valid_to >= ${today})) THEN 'machine'
                  WHEN EXISTS (SELECT 1 FROM finance_card_fees f WHERE f.machine_id = '' AND f.acquirer_id = m.acquirer_id
                               AND (f.valid_to = '' OR f.valid_to >= ${today})) THEN 'acquirer'
                  ELSE 'none'
                END AS feeSource
         FROM finance_card_machines m
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
    const database = await getD1();
    const validated = await validateMachineInput(database, scopeActor, allStores, body, editId);
    if ("error" in validated) return jsonResponse({ error: validated.error }, validated.status);
    const { input } = validated;

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
               updated_by=?12, updated_by_name=?13, updated_at=CURRENT_TIMESTAMP, admin_password=?15
           WHERE id=?14`,
        )
        .bind(
          input.acquirerId,
          input.acquirerName,
          input.model,
          input.serial,
          input.establishmentCode,
          input.terminal,
          input.companyId,
          input.companyName,
          input.installedAt,
          input.status,
          input.notes,
          actor.id,
          who,
          editId,
          input.adminPassword,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    const [insertSql, insertValues] = insertMachineSql(id, input, actor);
    await database.prepare(insertSql).bind(...insertValues).run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a maquineta.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A MAQUINETA." }, 500);
  }
}
