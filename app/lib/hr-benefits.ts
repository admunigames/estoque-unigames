// Lógica pura dos lançamentos de Benefícios (RH Financeiro).
//
// Um lançamento de benefício tem uma OU VÁRIAS linhas (hr_benefit_items),
// cada uma com um tipo, um valor bruto e um desconto próprios. Os totais
// do cabeçalho (hr_benefits) são desnormalizados a partir das linhas:
//   gross_cents    = Σ item.amountCents           (bruto — o que a DRE usa)
//   discount_cents = Σ item.discountCents
//   amount_cents   = gross_cents - discount_cents  (líquido — Folha/Fluxo de Caixa)

export const BENEFIT_TYPES = [
  "alimentacao",
  "mobilidade",
  "premiacao",
  "saldo_livre",
  "outros",
] as const;

export type BenefitType = (typeof BENEFIT_TYPES)[number];

export type ParsedBenefitItem = {
  type: BenefitType;
  amountCents: number;
  discountCents: number;
};

export type BenefitTotals = {
  grossCents: number;
  discountCents: number;
  netCents: number;
};

function isBenefitType(value: string): value is BenefitType {
  return (BENEFIT_TYPES as readonly string[]).includes(value);
}

function toCents(value: unknown): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Valida e normaliza a lista de linhas vinda da requisição. Aceita também
 * o formato antigo (type/amountCents/discountCents no corpo, sem `items`)
 * — nesse caso `fallback` monta uma linha única.
 */
export function parseBenefitItems(
  value: unknown,
  fallback?: { type?: unknown; amountCents?: unknown; discountCents?: unknown },
): { items: ParsedBenefitItem[]; error: string } {
  let list: unknown[];
  if (Array.isArray(value)) {
    list = value;
  } else if (fallback) {
    list = [{ type: fallback.type, amountCents: fallback.amountCents, discountCents: fallback.discountCents }];
  } else {
    return { items: [], error: "INFORME AO MENOS UM BENEFÍCIO NO LANÇAMENTO." };
  }

  if (!list.length) return { items: [], error: "INFORME AO MENOS UM BENEFÍCIO NO LANÇAMENTO." };
  if (list.length > 20) return { items: [], error: "NO MÁXIMO 20 BENEFÍCIOS POR LANÇAMENTO." };

  const items: ParsedBenefitItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") return { items: [], error: "LINHA DE BENEFÍCIO INVÁLIDA." };
    const entry = raw as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type.trim() : "";
    if (!isBenefitType(type)) {
      return { items: [], error: "SELECIONE UM TIPO DE BENEFÍCIO VÁLIDO EM CADA LINHA." };
    }
    const amountCents = toCents(entry.amountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return { items: [], error: "INFORME UM VALOR MAIOR QUE ZERO EM CADA BENEFÍCIO." };
    }
    const discountCents = entry.discountCents === undefined || entry.discountCents === null || entry.discountCents === ""
      ? 0
      : toCents(entry.discountCents);
    if (!Number.isFinite(discountCents) || discountCents < 0) {
      return { items: [], error: "O DESCONTO DE CADA BENEFÍCIO NÃO PODE SER NEGATIVO." };
    }
    if (discountCents > amountCents) {
      return { items: [], error: "O DESCONTO NÃO PODE SER MAIOR QUE O VALOR DO BENEFÍCIO." };
    }
    items.push({ type, amountCents, discountCents });
  }
  return { items, error: "" };
}

export function benefitTotalsFromItems(items: ParsedBenefitItem[]): BenefitTotals {
  const grossCents = items.reduce((sum, item) => sum + item.amountCents, 0);
  const discountCents = items.reduce((sum, item) => sum + item.discountCents, 0);
  return { grossCents, discountCents, netCents: grossCents - discountCents };
}

/**
 * Tipo do cabeçalho: o próprio tipo quando há uma linha só, 'multiplo'
 * quando há mais de um tipo distinto.
 */
export function headerBenefitType(items: ParsedBenefitItem[]): string {
  const distinct = new Set(items.map((item) => item.type));
  return distinct.size === 1 ? [...distinct][0] : "multiplo";
}
