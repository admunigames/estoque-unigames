// Lógica pura da Folha de Pagamento (RH Financeiro).
//
// Duas visões do mesmo lançamento:
//  - Folha Paga  = o líquido que sai da conta bancária PARA o funcionário.
//  - Custo Total = o custo cheio do funcionário para a empresa (é este que
//    alimenta Despesas/DRE). Usa sempre valores BRUTOS (nunca o valor já
//    descontado) e soma os encargos patronais.

const BASIS_POINTS_TOTAL = 10000;

export type PayrollManualValues = {
  baseSalaryCents: number;
  bonusCents: number;
  overtimeCents: number;
  additionsCents: number;
  deductionsCents: number;
  otherCents: number;
};

export type PayrollInputs = {
  /** Comissão líquida do mês (comissão + bônus + prêmios − descontos + ajustes). */
  commissionNetCents: number;
  /** Comissão bruta do mês (sem subtrair os descontos). */
  commissionGrossCents: number;
  /** Benefícios líquidos do mês (Σ amount_cents). */
  benefitsNetCents: number;
  /** Benefícios brutos do mês (Σ gross_cents). */
  benefitsGrossCents: number;
  /** Parte líquida dos benefícios paga via Pix (cai na conta do funcionário). */
  benefitsPixNetCents: number;
  /** Encargos patronais em pontos-base sobre o salário base. */
  employerChargesBps: number;
};

export type PayrollBreakdown = {
  /** base + bônus + he + adicionais + outros − descontos (só a parte salarial). */
  netSalaryCents: number;
  employerChargesCents: number;
  folhaPagaCents: number;
  custoTotalCents: number;
};

export function computePayrollBreakdown(
  values: PayrollManualValues,
  inputs: PayrollInputs,
): PayrollBreakdown {
  const salaryGrossCents =
    values.baseSalaryCents +
    values.bonusCents +
    values.overtimeCents +
    values.additionsCents +
    values.otherCents;

  const netSalaryCents = salaryGrossCents - values.deductionsCents;

  const employerChargesCents = Math.round(
    (values.baseSalaryCents * Math.max(0, inputs.employerChargesBps)) / BASIS_POINTS_TOTAL,
  );

  // Folha Paga: salário líquido + comissão líquida + benefícios via Pix.
  const folhaPagaCents =
    netSalaryCents + inputs.commissionNetCents + inputs.benefitsPixNetCents;

  // Custo Total: parte salarial BRUTA (sem subtrair o desconto do salário) +
  // comissão BRUTA + benefícios BRUTOS + encargos patronais.
  const custoTotalCents =
    salaryGrossCents +
    inputs.commissionGrossCents +
    inputs.benefitsGrossCents +
    employerChargesCents;

  return { netSalaryCents, employerChargesCents, folhaPagaCents, custoTotalCents };
}

/**
 * Valor "líquido" histórico da Folha (base + bônus + he + adicionais +
 * outros + comissão líquida + benefícios líquidos − descontos) — mantido
 * para compatibilidade com telas/integrações que já liam `netCents`.
 */
export function legacyNetCents(values: PayrollManualValues, inputs: PayrollInputs): number {
  return (
    values.baseSalaryCents +
    values.bonusCents +
    values.overtimeCents +
    values.additionsCents +
    values.otherCents +
    inputs.commissionNetCents +
    inputs.benefitsNetCents -
    values.deductionsCents
  );
}
