import { getD1 } from "../../../../db";
import { type CardFee } from "../../../lib/card-fees";
import { addDays } from "../../../lib/finance-status";
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
    .prepare(`SELECT ${CARD_FEE_COLUMNS} FROM finance_card_fees ORDER BY valid_from DESC`)
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
  validFrom: string;
  /** Taxa com fim já definido (ex.: promoção) entra como está, sem encerrar a anterior. */
  validTo?: string;
};

/**
 * Nova versão de uma taxa a partir de validFrom SEM apagar a anterior: a da
 * mesma chave (adquirente + maquineta + unidade + bandeira + modalidade +
 * parcelas) que ainda vale em validFrom recebe valid_to = véspera, e vendas
 * antigas mantêm o cálculo do dia. Se já existe uma começando no mesmo dia,
 * ela é atualizada (não duplica). `existing` = taxas já carregadas.
 */
export function planFeeVersion(
  existing: CardFeeRow[],
  fee: FeeVersion,
  actor: { id: string; name: string },
): Statement[] {
  const sameKey = existing.filter(
    (row) =>
      row.acquirerId === fee.acquirerId &&
      (row.machineId || "") === fee.machineId &&
      (row.companyId || "") === fee.companyId &&
      row.brand.trim().toLowerCase() === fee.brand.trim().toLowerCase() &&
      row.modality === fee.modality &&
      Number(row.installments || 1) === fee.installments,
  );
  const sameDay = sameKey.find((row) => (row.validFrom || "") === fee.validFrom);
  if (sameDay) {
    return [[
      `UPDATE finance_card_fees SET fee_bps=?1, anticipation_bps=?2, updated_by=?3, updated_by_name=?4,
         updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
      [fee.feeBps, fee.anticipationBps, actor.id, actor.name, sameDay.id],
    ]];
  }
  const statements: Statement[] = [];
  if (fee.validFrom && !fee.validTo) {
    const eve = addDays(fee.validFrom, -1);
    for (const row of sameKey) {
      if ((row.validFrom || "") < fee.validFrom && (!row.validTo || row.validTo >= fee.validFrom)) {
        statements.push([
          `UPDATE finance_card_fees SET valid_to=?1, updated_by=?2, updated_by_name=?3,
             updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
          [eve, actor.id, actor.name, row.id],
        ]);
      }
    }
  }
  statements.push([
    `INSERT INTO finance_card_fees
       (id, acquirer_id, acquirer_name, company_id, machine_id, brand, modality, installments,
        fee_bps, anticipation_bps, valid_from, valid_to,
        created_by, created_by_name, updated_by, updated_by_name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?14, ?12, ?13, ?12, ?13)`,
    [
      crypto.randomUUID(),
      fee.acquirerId,
      fee.acquirerName,
      fee.companyId,
      fee.machineId,
      fee.brand,
      fee.modality,
      fee.installments,
      fee.feeBps,
      fee.anticipationBps,
      fee.validFrom,
      actor.id,
      actor.name,
      fee.validTo || "",
    ],
  ]);
  return statements;
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
