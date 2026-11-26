import type { getD1 } from "../../../../db";
import { isAssistanceHub } from "../../../lib/commercial";
import { loadCompanyList } from "../shared";

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

// DRE (26/11/2026, pedido do usuário): os SERVIÇOS DA ASSISTÊNCIA de cada loja
// NÃO somam na receita da loja — somam na DRE da loja ASSISTÊNCIA (empresa
// cujo nome é ASSISTÊNCIA, isAssistanceHub). Loja: receita = VENDAS. ASSISTÊNCIA:
// VENDAS dela + SERVIÇOS de todas as lojas. A soma da rede (CONSOLIDADA) não muda.
// Sem empresa ASSISTÊNCIA cadastrada, fica como antes (vendas + serviços na loja).
// Rateio por faturamento e Declaração de Vendas continuam com o total da loja.
export type DreRevenue = CommercialRevenue & { isHub: boolean; servicesToHubCents: number };

export async function loadDreRevenueByStore(database: Database, month: string): Promise<Map<string, DreRevenue>> {
  const [revenue, companies] = await Promise.all([loadCommercialRevenueByStore(database, month), loadCompanyList(database)]);
  const hubId = companies.find((company) => isAssistanceHub(company.name))?.id ?? "";
  const byStore = new Map<string, DreRevenue>();
  if (!hubId) {
    for (const [storeId, row] of revenue) byStore.set(storeId, { ...row, isHub: false, servicesToHubCents: 0 });
    return byStore;
  }
  let servicesCents = 0;
  for (const [storeId, row] of revenue) {
    servicesCents += row.servicesCents;
    byStore.set(storeId, { ...row, servicesCents: 0, amountCents: row.salesCents, isHub: storeId === hubId, servicesToHubCents: row.servicesCents });
  }
  const hub = byStore.get(hubId) ?? { storeId: hubId, salesCents: 0, servicesCents: 0, amountCents: 0, updatedAt: "", updatedByName: "", isHub: true, servicesToHubCents: 0 };
  byStore.set(hubId, { ...hub, servicesCents, amountCents: hub.salesCents + servicesCents, isHub: true, servicesToHubCents: 0 });
  return byStore;
}
