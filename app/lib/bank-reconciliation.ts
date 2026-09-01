// Lógica pura da Conciliação Bancária (Financeiro Fase 7). Sem I/O:
// normalização do nome do estabelecimento (base do aprendizado por
// repetição), sugestão a partir das regras já aprendidas e parsing de
// extrato OFX. As rotas (app/api/finance/bank-reconciliation/*) fazem o SQL.

/**
 * Chave usada para agrupar lançamentos do mesmo estabelecimento e para o
 * aprendizado por repetição de nome: minúsculas, sem acento, sem os
 * sufixos de referência que variam a cada transação (números de NSU/doc,
 * asteriscos, datas), espaços colapsados.
 * Ex.: "NEOENERGIA PE *1234  05/08" -> "neoenergia pe"
 */
export function normalizeMerchantKey(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[*#]/g, " ")
    .replace(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g, " ") // datas
    .replace(/\b\d{4,}\b/g, " ") // ids longos
    .replace(/\bltda\b|\bs\/?a\b|\bme\b|\beireli\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ClassificationRule = {
  merchantKey: string;
  categoryItemId: string;
  subcategory: string;
  costCenterId: string;
  inDre: number;
  inRateio: number;
  hits: number;
};

/**
 * Sugere uma classificação para um lançamento a partir das regras já
 * aprendidas. Match exato de merchantKey; entre regras iguais, a de mais
 * ocorrências (hits) ganha. Devolve null quando não há histórico.
 */
export function suggestFromRules(
  merchantKey: string,
  rules: ClassificationRule[],
): ClassificationRule | null {
  if (!merchantKey) return null;
  const matches = rules.filter((rule) => rule.merchantKey === merchantKey);
  if (!matches.length) return null;
  matches.sort((a, b) => b.hits - a.hits);
  return matches[0];
}

export type OfxTransaction = {
  fitId: string;
  date: string;
  amountCents: number;
  description: string;
};

/**
 * Extrai as transações de um extrato OFX (SGML). Lê os blocos <STMTTRN>
 * e os campos DTPOSTED, TRNAMT, FITID, NAME/MEMO. amountCents preserva o
 * sinal (negativo = saída). Datas AAAAMMDD viram AAAA-MM-DD.
 */
export function parseOfxStatement(text: string): OfxTransaction[] {
  const out: OfxTransaction[] = [];
  const blocks = String(text || "").split(/<STMTTRN>/i).slice(1);
  for (const block of blocks) {
    const field = (tag: string): string => {
      const match = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
      return match ? match[1].trim() : "";
    };
    const posted = field("DTPOSTED").slice(0, 8);
    if (posted.length < 8) continue;
    const amount = Number.parseFloat(field("TRNAMT").replace(",", "."));
    if (!Number.isFinite(amount)) continue;
    const name = field("NAME") || field("MEMO");
    out.push({
      fitId: field("FITID"),
      date: `${posted.slice(0, 4)}-${posted.slice(4, 6)}-${posted.slice(6, 8)}`,
      amountCents: Math.round(amount * 100),
      description: name,
    });
  }
  return out;
}
