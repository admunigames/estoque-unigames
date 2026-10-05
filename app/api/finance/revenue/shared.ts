// Gravação do faturamento do mês (finance_store_revenue), compartilhada pelo
// lançamento manual (POST /revenue) e pela Conciliação de Vendas
// (apply-revenue). amount_cents é SEMPRE vendas + serviços.

export type RevenueStatement = [string, unknown[]];

export function planRevenueUpsert(
  existingId: string | null,
  input: { storeId: string; month: string; salesCents: number; servicesCents: number },
  actor: { id: string; name: string },
): RevenueStatement {
  const total = input.salesCents + input.servicesCents;
  if (existingId) {
    return [
      `UPDATE finance_store_revenue
       SET amount_cents=?1, sales_amount_cents=?2, services_amount_cents=?3,
           updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
       WHERE id=?6`,
      [total, input.salesCents, input.servicesCents, actor.id, actor.name, existingId],
    ];
  }
  return [
    `INSERT INTO finance_store_revenue
      (id, store_id, month, amount_cents, sales_amount_cents, services_amount_cents,
       created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)`,
    [crypto.randomUUID(), input.storeId, input.month, total, input.salesCents, input.servicesCents, actor.id, actor.name],
  ];
}
