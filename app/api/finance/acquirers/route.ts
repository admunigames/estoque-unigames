import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Cadastro de adquirentes (Cielo, Rede, Stone…). Compartilhado por
// Maquinetas, Taxas de Cartão e Recebíveis. company_id vazio ('') = global.
// Mesma permissão do resto do Financeiro (finance:manage) — nada novo.

type AcquirerRow = {
  id: string;
  name: string;
  companyId: string;
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
  const status = safeText(params.get("status"), 20);

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const values: unknown[] = [];
    // Adquirente global ('') aparece para todos; a específica de loja só para
    // quem enxerga aquela loja.
    if (!allStores) {
      values.push(scopeActor.companyId);
      conditions.push(`(company_id='' OR company_id=?${values.length})`);
    }
    if (status === "active" || status === "inactive") {
      values.push(status);
      conditions.push(`status=?${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(
        `SELECT id, name, company_id AS companyId, status, notes,
                created_by_name AS createdByName, created_at AS createdAt,
                updated_at AS updatedAt
         FROM finance_acquirers
         ${where}
         ORDER BY status ASC, lower(name) ASC`,
      )
      .bind(...values)
      .all<AcquirerRow>();
    return jsonResponse({ acquirers: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as adquirentes.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS ADQUIRENTES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR ADQUIRENTES." }, 403);
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
    const name = safeText(body.name, 120);
    const editId = safeText(body.id, 80);
    const status = safeText(body.status, 20) === "inactive" ? "inactive" : "active";
    const notes = safeText(body.notes, 500);
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DA ADQUIRENTE." }, 400);

    // Só admin/geral cadastra adquirente global; usuário de loja cadastra na
    // própria loja.
    let companyId = safeText(body.companyId, 80);
    if (!allStores) companyId = scopeActor.companyId;
    else if (companyId && !hasCompany(companyId)) companyId = "";

    const database = await getD1();
    const duplicate = await database
      .prepare(
        `SELECT id FROM finance_acquirers
         WHERE lower(name)=lower(?1) AND company_id=?2 AND id<>?3`,
      )
      .bind(name, companyId, editId || "")
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse({ error: "JÁ EXISTE UMA ADQUIRENTE COM ESSE NOME." }, 409);
    }

    const who = actor.displayName || "Administrador";
    if (editId) {
      const existing = await database
        .prepare("SELECT company_id AS companyId FROM finance_acquirers WHERE id=?1")
        .bind(editId)
        .first<{ companyId: string }>();
      if (!existing) return jsonResponse({ error: "ADQUIRENTE NÃO ENCONTRADA." }, 404);
      if (!allStores && existing.companyId !== scopeActor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO PODE EDITAR ESTA ADQUIRENTE." }, 403);
      }
      await database
        .prepare(
          `UPDATE finance_acquirers
           SET name=?1, status=?2, notes=?3, updated_by=?4, updated_by_name=?5, updated_at=now()::text
           WHERE id=?6`,
        )
        .bind(name, status, notes, actor.id, who, editId)
        .run();
      // Propaga o novo nome para as maquinetas dessa adquirente (o snapshot
      // acompanha o cadastro enquanto a adquirente não é renomeada de novo).
      await database
        .prepare("UPDATE finance_card_machines SET acquirer_name=?1 WHERE acquirer_id=?2")
        .bind(name, editId)
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_acquirers
          (id, name, company_id, status, notes, created_by, created_by_name, updated_by, updated_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?7)`,
      )
      .bind(id, name, companyId, status, notes, actor.id, who)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a adquirente.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A ADQUIRENTE." }, 500);
  }
}
