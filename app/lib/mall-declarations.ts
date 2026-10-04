// Regras de negócio da Declaração de Vendas (ex-"Declaração de Shopping",
// Financeiro — Fase 8 + ajuste 1/9 de 04/10/2026).
//
// Aluguel de shopping normalmente é o MAIOR valor entre:
//   (a) aluguel mínimo (fixo do contrato); e
//   (b) percentual contratual x faturamento declarado.
//
// O "ponto de virada" é o MAIOR valor declarado com o qual o aluguel
// percentual fica ZERADO: mínimo ÷ percentual, arredondado PARA BAIXO em
// centavos. Ele é o VALOR SUGERIDO para a declaração.
//   aluguel percentual = máx(0, declarado × percentual − mínimo)
//
// O alerta usa também o FATURAMENTO REAL — a exposição existe mesmo que a loja
// declare um valor menor. Quando o próprio declarado já passa do ponto de
// virada, o alerta é mais forte.
//
// public/estoque.html tem a mesma conta em declShoppingDerive (o front não
// importa TS); tests/finance-mall-declarations.test.mjs compara as duas.

export type MallDeclarationInput = {
  realRevenueCents: number;
  declaredCents: number;
  contractPercentBps: number;
  minimumRentCents: number;
};

export type MallDeclarationDerived = {
  // Valor sugerido = ponto de virada. 0 quando a loja não tem percentual.
  breakpointCents: number;
  // Calculado sobre o DECLARADO: máx(0, declarado × % − mínimo).
  percentageRentCents: number;
  // % do valor declarado sobre o faturamento real (pontos-base). 0 se sem real.
  declaredShareBps: number;
  alertLevel: "none" | "real" | "declared";
  alertMessage: string;
};

function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

export function deriveMallDeclaration(input: MallDeclarationInput): MallDeclarationDerived {
  const realRevenueCents = toInt(input.realRevenueCents);
  const declaredCents = toInt(input.declaredCents);
  const bps = toInt(input.contractPercentBps);
  const minimumRentCents = toInt(input.minimumRentCents);

  // Conta inteira: (mínimo × 10000) ÷ bps, sem erro de ponto flutuante.
  const breakpointCents = bps > 0 && minimumRentCents > 0 ? Math.floor((minimumRentCents * 10000) / bps) : 0;
  const percentageRentCents = bps > 0 ? Math.max(0, Math.round((declaredCents * bps) / 10000) - minimumRentCents) : 0;
  const declaredShareBps = realRevenueCents > 0 ? Math.round((declaredCents / realRevenueCents) * 10000) : 0;

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

  return { breakpointCents, percentageRentCents, declaredShareBps, alertLevel, alertMessage };
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
