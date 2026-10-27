import { getD1 } from "../../../../db";
import { normalizeBrand, refreshSaleFee, type CardFee } from "../../../lib/card-fees";
import { safeText, type Identity } from "../shared";

export type Database = Awaited<ReturnType<typeof getD1>>;
export type Statement = [string, unknown[]];

export const CARD_FEE_COLUMNS = `id, acquirer_id AS acquirerId, acquirer_name AS acquirerName,
  company_id AS companyId, machine_id AS machineId, brand, modality, installments, fee_bps AS feeBps,
  anticipation_bps AS anticipationBps, valid_from AS validFrom, valid_to AS validTo,
  created_by_name AS createdByName, created_at AS createdAt, updated_at AS updatedAt`;

export type CardFeeRow = CardFee & { acquirerName: string; companyId: string; machineId: string };

/**
 * Carrega TODAS as taxas cadastradas (adquirente e maquineta), no formato
 * que resolveCardFee() espera — ele mesmo separa por maquineta/unidade, o que
 * permite importar um arquivo com vendas de várias lojas.
 */
export async function loadCardFees(database: Database): Promise<CardFeeRow[]> {
  const result = await database
    .prepare(`SELECT ${CARD_FEE_COLUMNS} FROM finance_card_fees ORDER BY valid_from DESC`) // valid_to preenchido = histórico (ignorado)
    .all<CardFeeRow>();
  return (result.results ?? []).map((row) => ({
    ...row,
    machineId: row.machineId || "",
    companyId: row.companyId || "",
    installments: Number(row.installments || 1),
    feeBps: Number(row.feeBps || 0),
    anticipationBps: Number(row.anticipationBps || 0),
  }));
}

export type FeeVersion = {
  acquirerId: string;
  acquirerName: string;
  companyId: string;
  machineId: string;
  brand: string;
  modality: string;
  installments: number;
  feeBps: number;
  anticipationBps: number;
};

/**
 * Taxa SEM vigência: uma só por chave (adquirente + maquineta + unidade +
 * bandeira + modalidade + parcelas), sempre valendo. Gravar apaga as da mesma
 * chave (inclusive versões antigas com data) e insere a nova; as vendas já
 * importadas são recalculadas por refreshCardSales. `existing` = taxas carregadas.
 */
export function planFeeUpsert(
  existing: CardFeeRow[],
  fee: FeeVersion,
  actor: { id: string; name: string },
): Statement[] {
  const sameKey = existing.filter(
    (row) =>
      row.acquirerId === fee.acquirerId &&
      (row.machineId || "") === fee.machineId &&
      (row.companyId || "") === fee.companyId &&
      normalizeBrand(row.brand) === normalizeBrand(fee.brand) &&
      row.modality === fee.modality &&
      Number(row.installments || 1) === fee.installments,
  );
  return [
    ...sameKey.map((row): Statement => ["DELETE FROM finance_card_fees WHERE id=?1", [row.id]]),
    [
      `INSERT INTO finance_card_fees
         (id, acquirer_id, acquirer_name, company_id, machine_id, brand, modality, installments,
          fee_bps, anticipation_bps, valid_from, valid_to,
          created_by, created_by_name, updated_by, updated_by_name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '', '', ?11, ?12, ?11, ?12)`,
      [crypto.randomUUID(), fee.acquirerId, fee.acquirerName, fee.companyId, fee.machineId, fee.brand,
        fee.modality, fee.installments, fee.feeBps, fee.anticipationBps, actor.id, actor.name],
    ],
  ];
}

type StoredSaleRow = {
  id: string; saleDate: string; acquirerId: string; brand: string; modality: string; installments: number;
  grossCents: number; companyId: string; machineId: string; chargedFeeCents: number | null; receivedAmountCents: number | null;
  reviewedAt: string; feeBps: number; expectedFeeCents: number; netCents: number; feeMissing: number; feeCheck: string;
  reconStatus: string; divergenceCents: number | null;
};

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * Recalcula com a tabela atual as vendas já importadas da maquineta
 * (machine_id) ou da adquirente (acquirer_id); devolve quantas mudaram.
 */
export async function refreshCardSales(database: Database, column: "machine_id" | "acquirer_id", value: string): Promise<number> {
  if (!value) return 0;
  const fees = await loadCardFees(database);
  const result = await database
    .prepare(
      `SELECT id, sale_date AS saleDate, acquirer_id AS acquirerId, brand, modality, installments, gross_cents AS grossCents,
              company_id AS companyId, machine_id AS machineId, charged_fee_cents AS chargedFeeCents,
              received_amount_cents AS receivedAmountCents, reviewed_at AS reviewedAt, fee_bps AS feeBps,
              expected_fee_cents AS expectedFeeCents, net_cents AS netCents, fee_missing AS feeMissing, fee_check AS feeCheck,
              recon_status AS reconStatus, divergence_cents AS divergenceCents
       FROM finance_card_sales WHERE ${column}=?1`,
    )
    .bind(value)
    .all<StoredSaleRow>();
  const statements: Statement[] = [];
  for (const sale of result.results ?? []) {
    const next = refreshSaleFee(fees, {
      saleDate: sale.saleDate, acquirerId: sale.acquirerId, brand: sale.brand, modality: sale.modality,
      installments: Number(sale.installments || 1), grossCents: Number(sale.grossCents), machineId: sale.machineId || "",
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
  // ponytail: um UPDATE por venda alterada, em lotes de 200 por transação; UPDATE em massa se passar de dezenas de milhares.
  for (let index = 0; index < statements.length; index += 200) await runStatements(database, statements.slice(index, index + 200));
  return statements.length;
}

export function runStatements(database: Database, statements: Statement[]) {
  return statements.length
    ? database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)))
    : Promise.resolve([]);
}

export function scopeActorOf(request: Request, actor: Identity) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}
