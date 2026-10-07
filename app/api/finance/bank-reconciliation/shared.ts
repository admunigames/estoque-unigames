// Conciliação Bancária — partes compartilhadas pelo PATCH individual
// ([id]/route.ts) e pelo lote (bulk/route.ts).

type Database = {
  prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
};
type Statement = [string, unknown[]];
export type RuleFields = { categoryItemId: string; subcategory: string; costCenterId: string; inDre: number; inRateio: number };

/**
 * Aprendizado por repetição de nome: ao CONFIRMAR, upsert da regra
 * (loja + nome normalizado). `seen` evita duas INSERT da mesma regra no
 * mesmo lote (a segunda vira UPDATE com +1 acerto).
 */
export async function planRuleLearning(
  database: Database,
  companyId: string,
  merchantKey: string,
  fields: RuleFields,
  actor: { id: string; name: string },
  seen: Map<string, { id: string; hits: number }> = new Map(),
): Promise<Statement[]> {
  if (!merchantKey) return [];
  const key = `${companyId}|${merchantKey}`;
  let existing = seen.get(key) ?? null;
  if (!existing) {
    existing = await database
      .prepare("SELECT id, hits FROM finance_bank_classification_rules WHERE company_id=?1 AND merchant_key=?2")
      .bind(companyId, merchantKey)
      .first<{ id: string; hits: number }>();
  }
  if (existing) {
    const hits = Number(existing.hits || 0) + 1;
    seen.set(key, { id: existing.id, hits });
    return [[
      `UPDATE finance_bank_classification_rules
       SET category_item_id=?1, subcategory=?2, cost_center_id=?3, in_dre=?4, in_rateio=?5,
           hits=?6, updated_by=?7, updated_by_name=?8, updated_at=CURRENT_TIMESTAMP
       WHERE id=?9`,
      [fields.categoryItemId, fields.subcategory, fields.costCenterId, fields.inDre, fields.inRateio, hits, actor.id, actor.name, existing.id],
    ]];
  }
  const id = crypto.randomUUID();
  seen.set(key, { id, hits: 1 });
  return [[
    `INSERT INTO finance_bank_classification_rules
      (id, company_id, merchant_key, category_item_id, subcategory, cost_center_id,
       in_dre, in_rateio, hits, updated_by, updated_by_name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10)`,
    [id, companyId, merchantKey, fields.categoryItemId, fields.subcategory, fields.costCenterId, fields.inDre, fields.inRateio, actor.id, actor.name],
  ]];
}
