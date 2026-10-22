import type { getD1 } from "../../../../db";

// RECEITA da DRE = Comercial (fonte única, decisão do usuário 22/10/2026):
//   VENDAS   = commercial_store_goals.revenue_cents        (Meta Loja, FEITO)
//   SERVIÇOS = commercial_store_goals.assist_revenue_cents (Meta Assistência,
//              FEITO ASSISTÊNCIA)
// A Conciliação de Vendas (maquineta × sistema) não grava mais a DRE e os
// campos manuais de receita saíram. finance_store_revenue fica guardada sem
// uso. Também é a base do Rateio por Faturamento e da Declaração de Vendas.

type Database = Awaited<ReturnType<typeof getD1>>;

export type CommercialRevenue = {
  storeId: string;
  salesCents: number;
  servicesCents: number;
  amountCents: number;
  updatedAt: string;
  updatedByName: string;
};

export async function loadCommercialRevenueByStore(database: Database, month: string): Promise<Map<string, CommercialRevenue>> {
  const rows = await database
    .prepare(
      `SELECT company_id AS storeId, revenue_cents AS salesCents, assist_revenue_cents AS servicesCents,
              updated_at AS updatedAt, updated_by_name AS updatedByName,
              assist_updated_at AS assistUpdatedAt, assist_updated_by_name AS assistUpdatedByName
       FROM commercial_store_goals WHERE month=?1`,
    )
    .bind(month)
    .all<{
      storeId: string;
      salesCents: number;
      servicesCents: number;
      updatedAt: string;
      updatedByName: string;
      assistUpdatedAt: string;
      assistUpdatedByName: string;
    }>();
  const byStore = new Map<string, CommercialRevenue>();
  for (const row of rows.results ?? []) {
    const salesCents = Number(row.salesCents || 0);
    const servicesCents = Number(row.servicesCents || 0);
    const assistNewer = String(row.assistUpdatedAt || "") > String(row.updatedAt || "");
    byStore.set(row.storeId, {
      storeId: row.storeId,
      salesCents,
      servicesCents,
      amountCents: salesCents + servicesCents,
      updatedAt: assistNewer ? row.assistUpdatedAt : row.updatedAt || "",
      updatedByName: assistNewer ? row.assistUpdatedByName : row.updatedByName || "",
    });
  }
  return byStore;
}

export async function loadCommercialRevenue(database: Database, storeId: string, month: string): Promise<CommercialRevenue> {
  return (
    (await loadCommercialRevenueByStore(database, month)).get(storeId) ?? {
      storeId,
      salesCents: 0,
      servicesCents: 0,
      amountCents: 0,
      updatedAt: "",
      updatedByName: "",
    }
  );
}
