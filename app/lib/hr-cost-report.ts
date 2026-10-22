// CUSTO TOTAL POR FUNCIONÁRIO (RH > Folha de Pagamento, só para quem tem
// Financeiro) — lógica pura, sem banco. Fórmulas conferidas com a planilha de
// exemplo do usuário (22/10/2026), linha ALEXANDRE:
//   remuneração = salário base + comissão + HE + DSR (1.648,00 + 1.760,00 + 655,38 = 4.063,38)
//   FGTS mensal              = 8% × remuneração                         → 325,07
//   provisão férias + 1/3    = remuneração ÷ 12 × 4/3                   → 451,49
//   provisão 13º             = remuneração ÷ 12                         → 338,62
//   provisão FGTS férias     = 8% × provisão férias                     → 36,12
//   provisão FGTS 13º        = 8% × provisão 13º                        → 27,09
//   provisão FGTS rescisório = 40% × (FGTS mensal + FGTS férias + FGTS 13º) → 155,31
//   custo total = remuneração + todas as colunas de FGTS/provisão.
// Cada coluna é arredondada ao centavo antes de entrar na seguinte (como na
// planilha). O DSR é MANUAL (hr_employee_month_values, kind 'dsr') — sem
// cálculo automático até o usuário definir as verbas.

export const FGTS_RATE = 0.08;
export const FGTS_TERMINATION_RATE = 0.4;

export type EmployeeCostInput = {
  baseSalaryCents: number;
  commissionCents: number;
  overtimeCents: number;
  dsrCents: number;
};

export type EmployeeCost = EmployeeCostInput & {
  remunerationCents: number;
  fgtsCents: number;
  vacationProvisionCents: number;
  thirteenthProvisionCents: number;
  fgtsVacationCents: number;
  fgtsThirteenthCents: number;
  fgtsTerminationCents: number;
  totalCostCents: number;
};

const cents = (value: unknown) => Math.round(Number(value) || 0);

export function computeEmployeeCost(input: EmployeeCostInput): EmployeeCost {
  const baseSalaryCents = cents(input.baseSalaryCents);
  const commissionCents = cents(input.commissionCents);
  const overtimeCents = cents(input.overtimeCents);
  const dsrCents = cents(input.dsrCents);
  const remunerationCents = baseSalaryCents + commissionCents + overtimeCents + dsrCents;
  const fgtsCents = Math.round(remunerationCents * FGTS_RATE);
  const vacationProvisionCents = Math.round((remunerationCents / 12) * (4 / 3));
  const thirteenthProvisionCents = Math.round(remunerationCents / 12);
  const fgtsVacationCents = Math.round(vacationProvisionCents * FGTS_RATE);
  const fgtsThirteenthCents = Math.round(thirteenthProvisionCents * FGTS_RATE);
  const fgtsTerminationCents = Math.round((fgtsCents + fgtsVacationCents + fgtsThirteenthCents) * FGTS_TERMINATION_RATE);
  return {
    baseSalaryCents,
    commissionCents,
    overtimeCents,
    dsrCents,
    remunerationCents,
    fgtsCents,
    vacationProvisionCents,
    thirteenthProvisionCents,
    fgtsVacationCents,
    fgtsThirteenthCents,
    fgtsTerminationCents,
    totalCostCents:
      remunerationCents +
      fgtsCents +
      vacationProvisionCents +
      thirteenthProvisionCents +
      fgtsVacationCents +
      fgtsThirteenthCents +
      fgtsTerminationCents,
  };
}

const SUM_KEYS = [
  "baseSalaryCents",
  "commissionCents",
  "overtimeCents",
  "dsrCents",
  "remunerationCents",
  "fgtsCents",
  "vacationProvisionCents",
  "thirteenthProvisionCents",
  "fgtsVacationCents",
  "fgtsThirteenthCents",
  "fgtsTerminationCents",
  "totalCostCents",
] as const;

/** Linha TOTAL = soma das linhas (centavo a centavo, sem recalcular). */
export function sumEmployeeCosts(rows: EmployeeCost[]): EmployeeCost {
  const total = Object.fromEntries(SUM_KEYS.map((key) => [key, 0])) as EmployeeCost;
  for (const row of rows) for (const key of SUM_KEYS) total[key] += row[key];
  return total;
}
