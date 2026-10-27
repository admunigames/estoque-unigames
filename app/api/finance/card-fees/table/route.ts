import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { isCardModality, normalizeBrand, refreshSaleFee } from "../../../../lib/card-fees";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { loadCardFees, planFeeVersion, runStatements, scopeActorOf, type Database, type Statement } from "../shared";

// "TABELA DA MAQUINETA" (Financeiro 5/9): grade DÉBITO · PIX · CRÉDITO À
// VISTA · 2x…12x de uma maquineta (ou da adquirente, sem maquineta) salva
// numa requisição só, numa transação. Cada linha vira uma versão nova da
// taxa a partir de validFrom (a anterior recebe valid_to = véspera).
// { machineId?, acquirerId?, brand, validFrom, rows: [{modality, installments, feeBps, anticipationBps, brand?}] }
// A linha pode trazer a própria bandeira (IMPORTAR PLANILHA DE TAXAS manda a
// tabela inteira da maquineta, todas as bandeiras e parcelas até 21x).
// replace: true (planilha) — sem vigência: a taxa vale para qualquer data,
// substitui as taxas próprias da maquineta nas mesmas chaves e as vendas já
// importadas da maquineta são recalculadas na hora.

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
    const replace = body.replace === true;
    const validFrom = replace ? "" : safeText(body.validFrom, 10);
    if (replace && !machineId) return jsonResponse({ error: "ESCOLHA A MAQUINETA." }, 400);
    if (!replace && !DATE_RE.test(validFrom)) return jsonResponse({ error: "INFORME A VIGÊNCIA (A PARTIR DE)." }, 400);
    const rawRows = Array.isArray(body.rows) ? (body.rows as JsonMap[]) : [];
    if (!rawRows.length) return jsonResponse({ error: "PREENCHA AO MENOS UMA TAXA." }, 400);
    if (rawRows.length > 200) return jsonResponse({ error: "TABELA GRANDE DEMAIS." }, 400);

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

    let existing = await loadCardFees(database);
    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const statements: Statement[] = [];
    const seen = new Set<string>();
    if (replace) {
      // Substitui as taxas próprias da maquineta nas chaves da planilha (qualquer vigência).
      const keys = new Set(rawRows.map((raw) => {
        const modality = safeText(raw.modality, 12);
        const installments = modality === "credit" ? Math.round(Number(raw.installments) || 1) : 1;
        return `${normalizeBrand(raw.brand === undefined ? brand : safeText(raw.brand, 40))}:${modality}:${installments}`;
      }));
      const replaced = existing.filter((row) => row.machineId === machineId && keys.has(`${normalizeBrand(row.brand)}:${row.modality}:${Number(row.installments || 1)}`));
      statements.push(...replaced.map((row): Statement => ["DELETE FROM finance_card_fees WHERE id=?1", [row.id]]));
      existing = existing.filter((row) => !replaced.includes(row));
    }
    for (const raw of rawRows) {
      const modality = safeText(raw.modality, 12);
      if (!isCardModality(modality)) return jsonResponse({ error: "MODALIDADE INVÁLIDA." }, 400);
      const installments = modality === "credit" ? Math.round(Number(raw.installments) || 1) : 1;
      if (installments < 1 || installments > 48) return jsonResponse({ error: "PARCELAS DEVEM SER DE 1 A 48." }, 400);
      const rowBrand = raw.brand === undefined ? brand : safeText(raw.brand, 40);
      const feeBps = bps(raw.feeBps);
      const anticipationBps = bps(raw.anticipationBps ?? 0);
      if (feeBps === null || anticipationBps === null) {
        return jsonResponse({ error: "INFORME TAXAS VÁLIDAS (0 A 100%)." }, 400);
      }
      const key = `${normalizeBrand(rowBrand)}:${modality}:${installments}`;
      if (seen.has(key)) return jsonResponse({ error: "MODALIDADE/PARCELA REPETIDA NA TABELA." }, 400);
      seen.add(key);
      statements.push(
        ...planFeeVersion(
          existing,
          { acquirerId, acquirerName: acquirer.name, companyId, machineId, brand: rowBrand, modality, installments, feeBps, anticipationBps, validFrom },
          who,
        ),
      );
    }
    await runStatements(database, statements);
    const recalculated = replace ? await refreshMachineSales(database, machineId) : 0;
    return jsonResponse({ saved: rawRows.length, recalculated }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a tabela de taxas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A TABELA DE TAXAS." }, 500);
  }
}

type StoredSaleRow = {
  id: string; saleDate: string; acquirerId: string; brand: string; modality: string; installments: number;
  grossCents: number; companyId: string; chargedFeeCents: number | null; receivedAmountCents: number | null; reviewedAt: string;
  feeBps: number; expectedFeeCents: number; netCents: number; feeMissing: number; feeCheck: string; reconStatus: string;
  divergenceCents: number | null;
};

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Recalcula as vendas já importadas da maquineta com a tabela atual; devolve quantas mudaram. */
async function refreshMachineSales(database: Database, machineId: string): Promise<number> {
  const fees = await loadCardFees(database);
  const result = await database
    .prepare(
      `SELECT id, sale_date AS saleDate, acquirer_id AS acquirerId, brand, modality, installments, gross_cents AS grossCents,
              company_id AS companyId, charged_fee_cents AS chargedFeeCents, received_amount_cents AS receivedAmountCents,
              reviewed_at AS reviewedAt, fee_bps AS feeBps, expected_fee_cents AS expectedFeeCents, net_cents AS netCents,
              fee_missing AS feeMissing, fee_check AS feeCheck, recon_status AS reconStatus, divergence_cents AS divergenceCents
       FROM finance_card_sales WHERE machine_id=?1`,
    )
    .bind(machineId)
    .all<StoredSaleRow>();
  const statements: Statement[] = [];
  for (const sale of result.results ?? []) {
    const next = refreshSaleFee(fees, {
      saleDate: sale.saleDate, acquirerId: sale.acquirerId, brand: sale.brand, modality: sale.modality,
      installments: Number(sale.installments || 1), grossCents: Number(sale.grossCents), machineId,
      companyId: sale.companyId, chargedFeeCents: num(sale.chargedFeeCents), receivedAmountCents: num(sale.receivedAmountCents),
      reviewedAt: sale.reviewedAt || "",
    });
    const same = next.feeBps === Number(sale.feeBps) && next.expectedFeeCents === Number(sale.expectedFeeCents) &&
      next.netCents === Number(sale.netCents) && Number(next.feeMissing) === Number(sale.feeMissing) &&
      next.feeCheck === (sale.feeCheck || "") && next.reconStatus === sale.reconStatus &&
      next.divergenceCents === num(sale.divergenceCents);
    if (same) continue;
    statements.push([
      `UPDATE finance_card_sales SET fee_bps=?1, expected_fee_cents=?2, net_cents=?3, fee_missing=?4, fee_check=?5,
         recon_status=?6, divergence_cents=?7 WHERE id=?8`,
      [next.feeBps, next.expectedFeeCents, next.netCents, next.feeMissing ? 1 : 0, next.feeCheck, next.reconStatus, next.divergenceCents, sale.id],
    ]);
  }
  // ponytail: um UPDATE por venda alterada, em lotes de 200 por transação; UPDATE em massa se a maquineta tiver dezenas de milhares de vendas.
  for (let index = 0; index < statements.length; index += 200) await runStatements(database, statements.slice(index, index + 200));
  return statements.length;
}
