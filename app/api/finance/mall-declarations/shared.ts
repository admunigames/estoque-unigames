import type { getD1 } from "../../../../db";
import { deriveMallDeclaration } from "../../../lib/mall-declarations";
import type { JsonMap } from "../shared";

// Partes comuns da Declaração de Vendas usadas pela rota individual e pelo
// cadastro em lote (./batch).

type Database = Awaited<ReturnType<typeof getD1>>;

export type DeclarationValues = {
  realRevenueCents: number;
  declaredCents: number;
  contractPercentBps: number;
  minimumRentCents: number;
};

// Valida os números do corpo. Percentual em pontos-base (700 = 7%).
export function parseDeclarationValues(body: JsonMap): DeclarationValues | { error: string } {
  const cents = (value: unknown, label: string): number | { error: string } => {
    const n = value === undefined || value === null || value === "" ? 0 : Number(value);
    return Number.isInteger(n) && n >= 0 ? n : { error: `INFORME UM VALOR VÁLIDO EM CENTAVOS PARA ${label}.` };
  };
  const realRevenueCents = cents(body.realRevenueCents, "O FATURAMENTO REAL");
  if (typeof realRevenueCents !== "number") return realRevenueCents;
  const declaredCents = cents(body.declaredCents, "O VALOR DECLARADO");
  if (typeof declaredCents !== "number") return declaredCents;
  const minimumRentCents = cents(body.minimumRentCents, "O ALUGUEL MÍNIMO");
  if (typeof minimumRentCents !== "number") return minimumRentCents;
  const contractPercentBps = body.contractPercentBps === undefined || body.contractPercentBps === "" ? 0 : Number(body.contractPercentBps);
  if (!Number.isInteger(contractPercentBps) || contractPercentBps < 0 || contractPercentBps > 10000) {
    return { error: "INFORME O PERCENTUAL CONTRATUAL EM PONTOS-BASE (EX.: 700 = 7%)." };
  }
  // Sem percentual não há aluguel percentual: o mínimo também é zerado.
  return { realRevenueCents, declaredCents, contractPercentBps, minimumRentCents: contractPercentBps ? minimumRentCents : 0 };
}

export function insertDeclarationStatement(
  database: Database,
  row: DeclarationValues & {
    id: string;
    companyId: string;
    companyName: string;
    competenceMonth: string;
    percentageRentPaid: number;
    notes: string;
    actorId: string;
    who: string;
    plannedCents?: number;
  },
) {
  const derived = deriveMallDeclaration(row);
  return database
    .prepare(
      `INSERT INTO finance_mall_declarations
        (id, mall_name, company_id, company_name, competence_month, real_revenue_cents,
         suggested_declared_cents, declared_cents, contract_percent_bps, minimum_rent_cents,
         percentage_rent_cents, percentage_rent_paid, notes, created_by, created_by_name, created_at,
         updated_by, updated_by_name, updated_at, planned_cents)
       VALUES (?1,'',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,CURRENT_TIMESTAMP,?13,?14,CURRENT_TIMESTAMP,?15)`,
    )
    .bind(
      row.id, row.companyId, row.companyName, row.competenceMonth, row.realRevenueCents,
      derived.breakpointCents, row.declaredCents, row.contractPercentBps, row.minimumRentCents,
      derived.percentageRentCents, row.percentageRentPaid, row.notes, row.actorId, row.who, row.plannedCents ?? 0,
    );
}
