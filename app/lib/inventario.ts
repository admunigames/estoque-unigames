// Estoque > Inventário — regras puras (sem banco) usadas pela rota e pelos
// testes: casamento do relatório de custos com os produtos contados e o
// cálculo da diferença (contado − sistema) e do valor (custo × diferença).

export type CostRow = { code: string; barcode: string; gtin: string; name: string; costCents: number };
export type CountableItem = { id: string; code: string; product: string };

/** Nome para comparar: maiúsculas, sem acento e com espaços simples. */
export function normalizeName(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Código sem espaços nem zeros à esquerda (o relatório às vezes traz 0012). */
export function normalizeCode(value: string): string {
  return String(value || "").replace(/\s+/g, "").replace(/^0+(?=\d)/, "").toUpperCase();
}

/**
 * Custo de cada item: casa pelo CÓDIGO, depois pelo CÓDIGO DE BARRAS/GTIN do
 * relatório de custos e por último pelo NOME do produto (o código do relatório
 * de estoque nem sempre é o mesmo do relatório de produtos). Devolve
 * itemId → custo em centavos; quem não casar fica de fora.
 */
export function matchCosts(items: CountableItem[], costs: CostRow[]): Map<string, number> {
  const byCode = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const row of costs) {
    for (const code of [row.code, row.barcode, row.gtin]) {
      const key = normalizeCode(code);
      if (key && !byCode.has(key)) byCode.set(key, row.costCents);
    }
    const name = normalizeName(row.name);
    if (name && !byName.has(name)) byName.set(name, row.costCents);
  }
  const result = new Map<string, number>();
  for (const item of items) {
    const cost = byCode.get(normalizeCode(item.code)) ?? byName.get(normalizeName(item.product));
    if (cost !== undefined) result.set(item.id, cost);
  }
  return result;
}

/** Diferença contado − sistema (positivo = sobra, negativo = falta); null se não contado. */
export function difference(countedQty: number | null, systemQty: number): number | null {
  return countedQty === null || countedQty === undefined ? null : countedQty - systemQty;
}

/** Valor da divergência = custo × diferença (null sem custo ou sem contagem). */
export function differenceValueCents(countedQty: number | null, systemQty: number, costCents: number | null): number | null {
  const diff = difference(countedQty, systemQty);
  return diff === null || costCents === null || costCents === undefined ? null : diff * costCents;
}
