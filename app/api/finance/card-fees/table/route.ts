import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { isCardModality } from "../../../../lib/card-fees";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { loadCardFees, planFeeVersion, runStatements, scopeActorOf, type Statement } from "../shared";

// "TABELA DA MAQUINETA" (Financeiro 5/9): grade DÉBITO · PIX · CRÉDITO À
// VISTA · 2x…12x de uma maquineta (ou da adquirente, sem maquineta) salva
// numa requisição só, numa transação. Cada linha vira uma versão nova da
// taxa a partir de validFrom (a anterior recebe valid_to = véspera).
// { machineId?, acquirerId?, brand, validFrom, rows: [{modality, installments, feeBps, anticipationBps}] }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bps(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 && num <= 10000 ? Math.round(num) : null;
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR TAXAS DE CARTÃO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const machineId = safeText(body.machineId, 80);
    let acquirerId = safeText(body.acquirerId, 80);
    const brand = safeText(body.brand, 40);
    const validFrom = safeText(body.validFrom, 10);
    if (!DATE_RE.test(validFrom)) return jsonResponse({ error: "INFORME A VIGÊNCIA (A PARTIR DE)." }, 400);
    const rawRows = Array.isArray(body.rows) ? (body.rows as JsonMap[]) : [];
    if (!rawRows.length) return jsonResponse({ error: "PREENCHA AO MENOS UMA TAXA." }, 400);
    if (rawRows.length > 30) return jsonResponse({ error: "TABELA GRANDE DEMAIS." }, 400);

    const database = await getD1();
    let companyId = allStores ? "" : scopeActor.companyId;
    if (machineId) {
      const machine = await database
        .prepare("SELECT acquirer_id AS acquirerId, company_id AS companyId FROM finance_card_machines WHERE id=?1")
        .bind(machineId)
        .first<{ acquirerId: string; companyId: string }>();
      if (!machine) return jsonResponse({ error: "MAQUINETA NÃO ENCONTRADA." }, 404);
      if (!allStores && machine.companyId !== scopeActor.companyId) {
        return jsonResponse({ error: "ESSA MAQUINETA É DE OUTRA UNIDADE." }, 403);
      }
      acquirerId = machine.acquirerId;
      companyId = machine.companyId;
    }
    const acquirer = await database
      .prepare("SELECT name, company_id AS companyId FROM finance_acquirers WHERE id=?1")
      .bind(acquirerId)
      .first<{ name: string; companyId: string }>();
    if (!acquirer) return jsonResponse({ error: "SELECIONE A ADQUIRENTE." }, 400);
    if (!machineId && acquirer.companyId) companyId = acquirer.companyId;

    const existing = await loadCardFees(database);
    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const statements: Statement[] = [];
    const seen = new Set<string>();
    for (const raw of rawRows) {
      const modality = safeText(raw.modality, 12);
      if (!isCardModality(modality)) return jsonResponse({ error: "MODALIDADE INVÁLIDA." }, 400);
      const installments = modality === "credit" ? Math.round(Number(raw.installments) || 1) : 1;
      if (installments < 1 || installments > 12) return jsonResponse({ error: "PARCELAS DEVEM SER DE 1 A 12." }, 400);
      const feeBps = bps(raw.feeBps);
      const anticipationBps = bps(raw.anticipationBps ?? 0);
      if (feeBps === null || anticipationBps === null) {
        return jsonResponse({ error: "INFORME TAXAS VÁLIDAS (0 A 100%)." }, 400);
      }
      const key = `${modality}:${installments}`;
      if (seen.has(key)) return jsonResponse({ error: "MODALIDADE/PARCELA REPETIDA NA TABELA." }, 400);
      seen.add(key);
      statements.push(
        ...planFeeVersion(
          existing,
          { acquirerId, acquirerName: acquirer.name, companyId, machineId, brand, modality, installments, feeBps, anticipationBps, validFrom },
          who,
        ),
      );
    }
    await runStatements(database, statements);
    return jsonResponse({ saved: rawRows.length }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a tabela de taxas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A TABELA DE TAXAS." }, 500);
  }
}
