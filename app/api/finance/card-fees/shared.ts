import { getD1 } from "../../../../db";
import { type CardFee } from "../../../lib/card-fees";

export type Database = Awaited<ReturnType<typeof getD1>>;

export const CARD_FEE_COLUMNS = `id, acquirer_id AS acquirerId, acquirer_name AS acquirerName,
  company_id AS companyId, brand, modality, installments, fee_bps AS feeBps,
  anticipation_bps AS anticipationBps, valid_from AS validFrom, valid_to AS validTo,
  created_by_name AS createdByName, created_at AS createdAt, updated_at AS updatedAt`;

/**
 * Carrega as taxas cadastradas visíveis para a loja (global '' + a própria),
 * já no formato que resolveCardFee() espera. Usado pela importação de vendas
 * e pelo CRUD.
 */
export async function loadCardFees(
  database: Database,
  companyId: string,
): Promise<(CardFee & { acquirerName: string; companyId: string })[]> {
  const result = await database
    .prepare(
      `SELECT ${CARD_FEE_COLUMNS} FROM finance_card_fees
       WHERE company_id='' OR company_id=?1
       ORDER BY valid_from DESC`,
    )
    .bind(companyId || "")
    .all<CardFee & { acquirerName: string; companyId: string }>();
  return (result.results ?? []).map((row) => ({
    ...row,
    installments: Number(row.installments || 1),
    feeBps: Number(row.feeBps || 0),
    anticipationBps: Number(row.anticipationBps || 0),
  }));
}
