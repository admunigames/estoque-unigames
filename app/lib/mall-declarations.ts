// Regras de negócio da Declaração de Shopping (Financeiro — Fase 8).
//
// Aluguel de shopping normalmente é o MAIOR valor entre:
//   (a) aluguel mínimo (fixo do contrato); e
//   (b) percentual contratual x faturamento.
//
// O "ponto de virada" (breakpoint) é o faturamento a partir do qual (b)
// passa a superar (a):
//   ponto de virada = aluguel mínimo / (percentual contratual)
//
// Decisão do negócio (confirmada): o alerta usa o FATURAMENTO REAL — a
// exposição existe mesmo que a loja declare um valor menor. Quando o próprio
// valor declarado já passa do ponto de virada, o alerta é mais forte.

export type MallDeclarationInput = {
  realRevenueCents: number;
  declaredCents: number;
  avgDeclaredCents: number;
  contractPercentBps: number;
  minimumRentCents: number;
};

export type MallDeclarationDerived = {
  // Faturamento a partir do qual incide aluguel percentual (em centavos).
  // 0 quando não há percentual/mínimo configurado.
  breakpointCents: number;
  // Aluguel percentual teórico sobre o faturamento REAL e sobre o DECLARADO.
  percentageRentOnRealCents: number;
  percentageRentOnDeclaredCents: number;
  // Quanto o aluguel percentual (base real) excede o mínimo — 0 se não excede.
  overageOnRealCents: number;
  // % do valor declarado sobre o faturamento real (pontos-base). 0 se sem real.
  declaredShareBps: number;
  // Variação entre o valor declarado e a média que costuma ser declarada.
  declaredVsAverageCents: number;
  // Nível do alerta: 'none' | 'real' (real passou do ponto) | 'declared'
  // (a própria declaração já passou do ponto).
  alertLevel: "none" | "real" | "declared";
  alertMessage: string;
};

function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function deriveMallDeclaration(input: MallDeclarationInput): MallDeclarationDerived {
  const realRevenueCents = Math.max(0, toInt(input.realRevenueCents));
  const declaredCents = Math.max(0, toInt(input.declaredCents));
  const avgDeclaredCents = Math.max(0, toInt(input.avgDeclaredCents));
  const contractPercentBps = Math.max(0, toInt(input.contractPercentBps));
  const minimumRentCents = Math.max(0, toInt(input.minimumRentCents));

  const percentFraction = contractPercentBps / 10000;
  const breakpointCents =
    percentFraction > 0 && minimumRentCents > 0
      ? Math.round(minimumRentCents / percentFraction)
      : 0;

  const percentageRentOnRealCents = Math.round(realRevenueCents * percentFraction);
  const percentageRentOnDeclaredCents = Math.round(declaredCents * percentFraction);
  const overageOnRealCents = Math.max(0, percentageRentOnRealCents - minimumRentCents);
  const declaredShareBps =
    realRevenueCents > 0 ? Math.round((declaredCents / realRevenueCents) * 10000) : 0;
  const declaredVsAverageCents = declaredCents - avgDeclaredCents;

  let alertLevel: MallDeclarationDerived["alertLevel"] = "none";
  let alertMessage = "";
  if (breakpointCents > 0 && declaredCents > breakpointCents) {
    alertLevel = "declared";
    alertMessage =
      "O VALOR DECLARADO JÁ ULTRAPASSA O PONTO DE VIRADA — HÁ INCIDÊNCIA DE ALUGUEL PERCENTUAL ALÉM DO MÍNIMO.";
  } else if (breakpointCents > 0 && realRevenueCents > breakpointCents) {
    alertLevel = "real";
    alertMessage =
      "O FATURAMENTO REAL ULTRAPASSA O PONTO DE VIRADA — POSSÍVEL INCIDÊNCIA DE ALUGUEL PERCENTUAL.";
  }

  return {
    breakpointCents,
    percentageRentOnRealCents,
    percentageRentOnDeclaredCents,
    overageOnRealCents,
    declaredShareBps,
    declaredVsAverageCents,
    alertLevel,
    alertMessage,
  };
}

// Soma 3 meses de calendário a uma data ISO (AAAA-MM-DD), preservando o
// último dia do mês quando o mês de destino é mais curto.
export function addThreeMonths(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const base = new Date(Date.UTC(year, month - 1 + 3, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  const finalDay = Math.min(day, lastDay);
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(finalDay).padStart(2, "0");
  return `${base.getUTCFullYear()}-${mm}-${dd}`;
}
