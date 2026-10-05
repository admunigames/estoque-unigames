import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { computeCardReconStatus } from "../../../../lib/card-fees";
import { todayInTimezone } from "../../../../lib/finance-status";
import { allocateDeposit } from "../../../../lib/sales-recon";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runStatements, scopeActorOf, type Statement } from "../../card-fees/shared";
import { loadDepositDays, monthRange } from "../shared";

// CARTÃO × BANCO (Financeiro 6/9; substitui a aba REPASSE de Maquinetas).
// GET ?month&companyId: um dia por adquirente × data de depósito, com o
// esperado (vendas da maquineta pelo prazo da adquirente) e o depositado
// (extrato com o bank_keyword). POST { action, month, companyId, ids, fields }:
// - apply: CONCILIAR — grava no extrato sales_recon_status/acquirer_id e, nas
//   vendas da maquineta, received_amount_cents/settled_at (depósito do dia
//   rateado pelo líquido esperado);
// - review: MARCAR COMO REVISADO (ids = dias "adquirente|data", fields.note).

function scopeOf(request: Request) {
  const actor = identity(request);
  const scopeActor = scopeActorOf(request, actor);
  return { actor, scopeActor, allStores: canSeeAllStores(scopeActor, "finance:manage") };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const { actor, scopeActor, allStores } = scopeOf(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const params = new URL(request.url).searchParams;
  const month = safeText(params.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  const companyId = allStores ? safeText(params.get("companyId"), 80) : scopeActor.companyId;

  try {
    const database = await getD1();
    const today = todayInTimezone();
    const { days, acquirers, saleById, entryById } = await loadDepositDays(database, { ...monthRange(month), companyId, today });
    const acquirerName = new Map(acquirers.map((row) => [row.id, row.name]));
    return jsonResponse({
      month,
      today,
      missingKeyword: acquirers.filter((row) => !row.bankKeyword.trim()).map((row) => row.name),
      days: days.map((day) => ({
        key: day.key,
        acquirerId: day.acquirerId,
        acquirerName: acquirerName.get(day.acquirerId) ?? "—",
        date: day.date,
        expectedCents: day.expectedCents,
        depositedCents: day.depositedCents,
        differenceCents: day.differenceCents,
        status: day.status,
        note: day.deposits.map((line) => entryById.get(line.entryId)?.salesReconNote ?? "").find(Boolean) ?? "",
        sales: day.expected.map((line) => {
          const sale = saleById.get(line.saleId);
          return {
            saleId: line.saleId,
            saleDate: sale?.saleDate ?? "",
            modality: sale?.modality ?? "",
            installments: sale?.installments ?? 1,
            grossCents: sale?.grossCents ?? 0,
            netCents: line.netCents,
          };
        }),
        entries: day.deposits.map((line) => ({
          entryId: line.entryId,
          description: entryById.get(line.entryId)?.description ?? "",
          amountCents: line.amountCents,
        })),
      })),
    });
  } catch (error) {
    console.error("Não foi possível carregar o cartão × banco.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CARTÃO × BANCO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const { actor, scopeActor, allStores } = scopeOf(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONCILIAR DEPÓSITOS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 12);
    const month = safeText(body.month, 7);
    if (action !== "apply" && action !== "review") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
    const companyId = allStores ? safeText(body.companyId, 80) : scopeActor.companyId;
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const today = todayInTimezone();
    const { days, saleById } = await loadDepositDays(database, { ...monthRange(month), companyId, today });
    const statements: Statement[] = [];
    const skipped: Array<{ id: string; description: string; reason: string }> = [];

    if (action === "review") {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 120)).filter(Boolean))];
      if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM DIA." }, 400);
      const byKey = new Map(days.map((day) => [day.key, day]));
      if (ids.some((id) => !byKey.has(id))) {
        return jsonResponse({ error: "ALGUM DIA SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
      }
      const note = safeText(fields.note, 300);
      for (const id of ids) {
        const day = byKey.get(id)!;
        if (!day.deposits.length) {
          skipped.push({ id, description: day.date, reason: "SEM DEPÓSITO NO EXTRATO PARA REVISAR" });
          continue;
        }
        for (const line of day.deposits) {
          statements.push([
            `UPDATE finance_bank_statement_entries SET sales_recon_status='reviewed', sales_recon_note=?1, acquirer_id=?2,
               updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
            [note, day.acquirerId, actor.id, actor.displayName || "Administrador", line.entryId],
          ]);
        }
      }
      await runStatements(database, statements);
      return jsonResponse({ applied: ids.length - skipped.length, skipped });
    }

    // apply: depósito do dia rateado entre as parcelas esperadas.
    const received = new Map<string, { cents: number; parcels: number }>();
    let daysApplied = 0;
    for (const day of days) {
      const entryStatus = day.status === "ok" ? "ok" : "divergent";
      for (const line of day.deposits) {
        if (line.reviewed) continue;
        statements.push([
          "UPDATE finance_bank_statement_entries SET sales_recon_status=?1, acquirer_id=?2 WHERE id=?3",
          [entryStatus, day.acquirerId, line.entryId],
        ]);
      }
      if (!day.expected.length || !day.deposits.length) continue;
      daysApplied += 1;
      const lines = day.expected.map((line, index) => ({ id: `${line.saleId}#${index}`, saleId: line.saleId, netCents: line.netCents }));
      const shares = allocateDeposit(day.depositedCents, lines);
      for (const line of lines) {
        const item = received.get(line.saleId) ?? { cents: 0, parcels: 0 };
        item.cents += shares.get(line.id) ?? 0;
        item.parcels += 1;
        received.set(line.saleId, item);
      }
    }
    const settledAt = new Date().toISOString();
    let salesUpdated = 0;
    for (const [saleId, item] of received) {
      const sale = saleById.get(saleId);
      // ponytail: parcelada com parcelas em meses diferentes só grava o
      // recebido quando todas caem no mês conciliado; somar entre meses se precisar.
      if (!sale || item.parcels < sale.parcels) continue;
      const reconStatus = sale.reviewedAt
        ? "reviewed"
        : computeCardReconStatus({
            feeMissing: false,
            grossCents: Number(sale.grossCents),
            expectedFeeCents: Number(sale.expectedFeeCents),
            receivedCents: item.cents,
          });
      statements.push([
        `UPDATE finance_card_sales SET received_amount_cents=?1, divergence_cents=?2, settled_at=?3, recon_status=?4 WHERE id=?5`,
        [item.cents, item.cents - Number(sale.netCents), settledAt, reconStatus, saleId],
      ]);
      salesUpdated += 1;
    }
    await runStatements(database, statements);
    return jsonResponse({ applied: daysApplied, salesUpdated, skipped });
  } catch (error) {
    console.error("Não foi possível conciliar os depósitos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCILIAR OS DEPÓSITOS." }, 500);
  }
}
