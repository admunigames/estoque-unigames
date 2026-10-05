import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { isCardModality } from "../../../lib/card-fees";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import { CARD_FEE_COLUMNS, loadCardFees, planFeeVersion, runStatements } from "./shared";

// Tabela de Taxas de Cartão (Financeiro Fase 7; aba TAXAS de Maquinetas no
// 5/9). Mesma permissão e escopo do resto do módulo. company_id vazio ('') =
// taxa global; machine_id preenchido = taxa própria da maquineta (gravada com
// a unidade da maquineta). Taxa NOVA encerra a anterior da mesma chave na
// véspera (planFeeVersion) — editar continua alterando a linha.

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

function toBps(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 10000) return null;
  return Math.round(num);
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

  try {
    const database = await getD1();
    const values: unknown[] = [];
    let where = "";
    if (!allStores) {
      values.push(scopeActor.companyId);
      where = `WHERE company_id='' OR company_id=?1
        OR machine_id IN (SELECT id FROM finance_card_machines WHERE company_id=?1)`;
    }
    const result = await database
      .prepare(
        `SELECT ${CARD_FEE_COLUMNS} FROM finance_card_fees
         ${where}
         ORDER BY lower(acquirer_name) ASC, modality ASC, installments ASC, valid_from DESC`,
      )
      .bind(...values)
      .all();
    return jsonResponse({ fees: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as taxas de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS TAXAS DE CARTÃO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR TAXAS DE CARTÃO." }, 403);
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
    const modality = safeText(body.modality, 12);
    const brand = safeText(body.brand, 40);
    const validFrom = safeText(body.validFrom, 10);
    const validTo = safeText(body.validTo, 10);
    if (!acquirerId) return jsonResponse({ error: "SELECIONE A ADQUIRENTE." }, 400);
    if (!isCardModality(modality)) return jsonResponse({ error: "MODALIDADE INVÁLIDA." }, 400);

    let installments = Math.round(Number(body.installments) || 1);
    if (modality !== "credit") installments = 1;
    if (installments < 1 || installments > 48) {
      return jsonResponse({ error: "QUANTIDADE DE PARCELAS INVÁLIDA." }, 400);
    }
    const feeBps = toBps(body.feeBps);
    if (feeBps === null) return jsonResponse({ error: "INFORME UMA TAXA VÁLIDA (0 A 100%)." }, 400);
    const anticipationBps = toBps(body.anticipationBps ?? 0);
    if (anticipationBps === null) {
      return jsonResponse({ error: "INFORME UMA TAXA DE ANTECIPAÇÃO VÁLIDA." }, 400);
    }
    if (validFrom && !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
      return jsonResponse({ error: "DATA DE INÍCIO DA VIGÊNCIA INVÁLIDA." }, 400);
    }
    if (validTo && !/^\d{4}-\d{2}-\d{2}$/.test(validTo)) {
      return jsonResponse({ error: "DATA DE FIM DA VIGÊNCIA INVÁLIDA." }, 400);
    }
    if (validFrom && validTo && validTo < validFrom) {
      return jsonResponse({ error: "A VIGÊNCIA TERMINA ANTES DE COMEÇAR." }, 400);
    }

    const database = await getD1();
    const machineId = safeText(body.machineId, 80);
    const machine = machineId
      ? await database
          .prepare("SELECT acquirer_id AS acquirerId, company_id AS companyId FROM finance_card_machines WHERE id=?1")
          .bind(machineId)
          .first<{ acquirerId: string; companyId: string }>()
      : null;
    if (machineId && !machine) return jsonResponse({ error: "MAQUINETA NÃO ENCONTRADA." }, 400);
    if (machine && !allStores && machine.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "ESSA MAQUINETA É DE OUTRA UNIDADE." }, 403);
    }
    if (machine && machine.acquirerId !== acquirerId) {
      return jsonResponse({ error: "A ADQUIRENTE NÃO É A DA MAQUINETA." }, 400);
    }
    const acquirer = await database
      .prepare("SELECT name, company_id AS companyId FROM finance_acquirers WHERE id=?1")
      .bind(acquirerId)
      .first<{ name: string; companyId: string }>();
    if (!acquirer) return jsonResponse({ error: "ADQUIRENTE NÃO ENCONTRADA." }, 400);

    let companyId = safeText(body.companyId, 80);
    if (machine) companyId = machine.companyId;
    else if (!allStores) companyId = scopeActor.companyId;
    else if (companyId && !hasCompany(companyId)) companyId = "";
    if (!machine && acquirer.companyId && acquirer.companyId !== companyId) {
      return jsonResponse({ error: "ESSA ADQUIRENTE É DE OUTRA UNIDADE." }, 400);
    }

    const who = actor.displayName || "Administrador";
    if (editId) {
      const existing = await database
        .prepare("SELECT company_id AS companyId FROM finance_card_fees WHERE id=?1")
        .bind(editId)
        .first<{ companyId: string }>();
      if (!existing) return jsonResponse({ error: "TAXA NÃO ENCONTRADA." }, 404);
      if (!allStores && existing.companyId !== scopeActor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO PODE EDITAR ESTA TAXA." }, 403);
      }
      await database
        .prepare(
          `UPDATE finance_card_fees
           SET acquirer_id=?1, acquirer_name=?2, company_id=?3, brand=?4, modality=?5, installments=?6,
               fee_bps=?7, anticipation_bps=?8, valid_from=?9, valid_to=?10,
               updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP, machine_id=?14
           WHERE id=?13`,
        )
        .bind(
          acquirerId,
          acquirer.name,
          companyId,
          brand,
          modality,
          installments,
          feeBps,
          anticipationBps,
          validFrom,
          validTo,
          actor.id,
          who,
          editId,
          machineId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const statements = planFeeVersion(
      await loadCardFees(database),
      { acquirerId, acquirerName: acquirer.name, companyId, machineId, brand, modality, installments, feeBps, anticipationBps, validFrom, validTo },
      { id: actor.id, name: who },
    );
    await runStatements(database, statements);
    return jsonResponse({ created: true, closedPrevious: statements.length - 1 }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a taxa de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A TAXA DE CARTÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR TAXAS DE CARTÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "TAXA INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT company_id AS companyId FROM finance_card_fees WHERE id=?1")
      .bind(id)
      .first<{ companyId: string }>();
    if (!existing) return jsonResponse({ deleted: true });
    if (!allStores && existing.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO PODE EXCLUIR ESTA TAXA." }, 403);
    }
    await database.prepare("DELETE FROM finance_card_fees WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a taxa de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A TAXA DE CARTÃO." }, 500);
  }
}
