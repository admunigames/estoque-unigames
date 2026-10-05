import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { todayInTimezone } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { loadCardFees, planFeeVersion, runStatements, scopeActorOf, type Statement } from "../../card-fees/shared";

// Ações em lote na aba MAQUINETAS (Financeiro 5/9):
// { action: 'inactivate' | 'reactivate' | 'copy_fees', ids, fields }.
// - inactivate / reactivate: ativa ↔ inativa (transferida/cancelada é
//   pulada — transferência continua só pelo histórico, que grava o evento);
// - copy_fees: copia a tabela VIGENTE da maquineta-modelo
//   (fields.sourceMachineId) para as selecionadas, como versão nova a partir
//   de fields.validFrom (vazio = a mesma vigência da modelo). É o "cadastrar
//   em lote" das taxas.
// Todos os ids conferidos antes (404/403); gravação numa transação.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type MachineRow = {
  id: string;
  acquirerId: string;
  acquirerName: string;
  companyId: string;
  status: string;
  label: string;
};

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR MAQUINETAS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (!["inactivate", "reactivate", "copy_fees"].includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA MAQUINETA." }, 400);
    if (ids.length > 300) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 300)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;
    const sourceMachineId = safeText(fields.sourceMachineId, 80);
    const validFrom = safeText(fields.validFrom, 10);
    if (action === "copy_fees" && !sourceMachineId) return jsonResponse({ error: "ESCOLHA A MAQUINETA-MODELO." }, 400);
    if (validFrom && !DATE_RE.test(validFrom)) return jsonResponse({ error: "DATA DE VIGÊNCIA INVÁLIDA." }, 400);

    const database = await getD1();
    const lookup = [...ids, ...(sourceMachineId ? [sourceMachineId] : [])];
    const found = await database
      .prepare(
        `SELECT id, acquirer_id AS acquirerId, acquirer_name AS acquirerName, company_id AS companyId, status,
                acquirer_name || ' ' || model || ' ' || serial AS label
         FROM finance_card_machines WHERE id IN (${lookup.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...lookup)
      .all<MachineRow>();
    const byId = new Map((found.results ?? []).map((row) => [row.id, row]));
    if (lookup.some((id) => !byId.has(id))) {
      return jsonResponse({ error: "ALGUMA MAQUINETA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    }
    if (!allStores && lookup.some((id) => byId.get(id)!.companyId !== scopeActor.companyId)) {
      return jsonResponse({ error: "VOCÊ NÃO PODE ALTERAR MAQUINETAS DE OUTRA UNIDADE." }, 403);
    }

    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const statements: Statement[] = [];
    let applied = 0;

    if (action === "copy_fees") {
      const today = todayInTimezone();
      const allFees = await loadCardFees(database);
      const sourceFees = allFees.filter(
        (fee) => fee.machineId === sourceMachineId && (!fee.validTo || fee.validTo >= today) && (fee.validFrom || "") <= today,
      );
      if (!sourceFees.length) {
        return jsonResponse({ error: "A MAQUINETA-MODELO NÃO TEM TAXAS PRÓPRIAS VIGENTES." }, 400);
      }
      for (const id of ids) {
        const target = byId.get(id)!;
        if (id === sourceMachineId) {
          skipped.push({ id, description: target.label, reason: "É A PRÓPRIA MAQUINETA-MODELO" });
          continue;
        }
        for (const fee of sourceFees) {
          statements.push(
            ...planFeeVersion(
              allFees,
              {
                acquirerId: target.acquirerId,
                acquirerName: target.acquirerName,
                companyId: target.companyId,
                machineId: id,
                brand: fee.brand,
                modality: fee.modality,
                installments: fee.installments,
                feeBps: fee.feeBps,
                anticipationBps: fee.anticipationBps,
                validFrom: validFrom || fee.validFrom || today,
              },
              who,
            ),
          );
        }
        applied += 1;
      }
    } else {
      const [from, to] = action === "inactivate" ? ["active", "inactive"] : ["inactive", "active"];
      for (const id of ids) {
        const machine = byId.get(id)!;
        if (machine.status !== from) {
          skipped.push({ id, description: machine.label, reason: action === "inactivate" ? "NÃO ESTÁ ATIVA" : "NÃO ESTÁ INATIVA" });
          continue;
        }
        statements.push([
          `UPDATE finance_card_machines SET status=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
          [to, who.id, who.name, id],
        ]);
        applied += 1;
      }
    }
    await runStatements(database, statements);
    return jsonResponse({ applied, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de maquinetas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APLICAR O LOTE DE MAQUINETAS." }, 500);
  }
}
