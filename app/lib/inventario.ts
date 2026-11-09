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
 * de estoque nem sempre é o mesmo do relatório de produtos). O CÓDIGO de um
 * produto vale antes do código de barras de OUTRO (09/11/2026: a calculadora
 * Casio tinha como cód. barras 78900002278 = código do MOUSE PAD C/APOIO e o
 * mouse pad saía com R$ 65,00 em vez de R$ 7,00). Devolve itemId → custo em
 * centavos; quem não casar fica de fora.
 */
export function matchCosts(items: CountableItem[], costs: CostRow[]): Map<string, number> {
  const byCode = new Map<string, number>();
  const byBarcode = new Map<string, number>();
  const byName = new Map<string, number>();
  const put = (map: Map<string, number>, key: string, cost: number) => { if (key && !map.has(key)) map.set(key, cost); };
  for (const row of costs) {
    put(byCode, normalizeCode(row.code), row.costCents);
    put(byBarcode, normalizeCode(row.barcode), row.costCents);
    put(byBarcode, normalizeCode(row.gtin), row.costCents);
    put(byName, normalizeName(row.name), row.costCents);
  }
  const result = new Map<string, number>();
  for (const item of items) {
    const code = normalizeCode(item.code);
    const cost = byCode.get(code) ?? byBarcode.get(code) ?? byName.get(normalizeName(item.product));
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
