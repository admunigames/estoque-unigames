// Comercial > FIDELIZA — leitura do "Relatório de Pdv" do sistema da loja.
//
// O .xls é uma página HTML (ISO-8859-1, o navegador decodifica antes de
// enviar). Topo com "UNIGAMES <LOJA>", rodapé "Valores Finais" (ignorado) e
// linhas de 15 colunas SEM cabeçalho, uma por ITEM (a venda se repete):
//   0 nº venda · 1 status · 2 data · 3 data 00/00/0000 · 4 cliente ·
//   5 telefone · 6 vendedor · 7 "Tipo Pagamento: X" · 8 cód. produto ·
//   9 produto · 10 CFOP · 11 preço tabela · 12 qtd · 13 valor do item ·
//   14 total da venda
// Só vira venda de cliente: status FINALIZADO + telefone válido (o balcão
// "CLIENTES UNIGAMES"/00000000 não é cliente).

export type FidelizaItem = { code: string; name: string; qty: number; cents: number };
export type FidelizaSale = {
  saleNo: string;
  saleDate: string;
  customerKey: string;
  customerName: string;
  seller: string;
  payment: string;
  totalCents: number;
  items: FidelizaItem[];
};
export type FidelizaReport = {
  storeLabel: string;
  rows: number;
  salesTotal: number;
  sales: FidelizaSale[];
  periodStart: string;
  periodEnd: string;
};

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ACCENTS: Record<string, string> = { acute: "\u0301", grave: "\u0300", tilde: "\u0303", circ: "\u0302", uml: "\u0308", cedil: "\u0327" };

function cellText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] !== "#") {
        // &atilde; &ccedil; &Eacute;… → letra + acento combinado.
        const accent = /^([a-z])(acute|grave|tilde|circ|uml|cedil)$/i.exec(code);
        return accent ? (accent[1] + ACCENTS[accent[2].toLowerCase()]).normalize("NFC") : (ENTITIES[code.toLowerCase()] ?? match);
      }
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const upper = (value: string) => value.toLocaleUpperCase("pt-BR");

/** "11/11/2026" → "2026-11-11" ("" se inválida). */
export function isoDate(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(value.trim());
  if (!match || match[3] === "0000") return "";
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ? "" : iso;
}

/** "1.234,56" / "R$ 10,00" → centavos. */
export function cents(value: string) {
  const clean = value.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const number = Number(clean);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

/**
 * Telefone → chave do cliente: DDD + número (11 dígitos no celular). Sem DDD
 * assume 81 (lojas de Recife). "" = não identificado.
 */
export function phoneKey(value: string) {
  let digits = value.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length >= 12 && digits.startsWith("55")) digits = digits.slice(2);
  if (digits.length === 8 || digits.length === 9) digits = `81${digits}`;
  // Celular antigo sem o 9 (DDD + 8 dígitos começando em 6–9).
  if (digits.length === 10 && /[6-9]/.test(digits[2])) digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
  if (digits.length !== 10 && digits.length !== 11) return "";
  if (/^(\d)\1+$/.test(digits.slice(2))) return "";
  return digits;
}

export function parsePdvReport(html: string): FidelizaReport {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cellText(cell[1])),
  );
  const lines = rows.filter((cells) => cells.length === 15 && isoDate(cells[2]));
  const topText = rows.filter((cells) => cells.length < 15).map((cells) => cells.join(" ")).join(" ");
  const storeMatch = /UNIGAMES\s+([A-ZÀ-Ü0-9 ]+?)(?=\s*(?:Relat|Per[ií]odo|$))/i.exec(topText);

  const bySale = new Map<string, { sale: FidelizaSale; ok: boolean }>();
  for (const cells of lines) {
    const saleNo = cells[0].replace(/\s/g, "");
    if (!saleNo) continue;
    let entry = bySale.get(saleNo);
    if (!entry) {
      const customerName = upper(cells[4]).slice(0, 120);
      const customerKey = /CLIENTES UNIGAMES/.test(customerName) ? "" : phoneKey(cells[5]);
      entry = {
        ok: /^finaliz/i.test(cells[1]) && Boolean(customerKey),
        sale: {
          saleNo, saleDate: isoDate(cells[2]), customerKey, customerName, seller: upper(cells[6]).slice(0, 120),
          payment: upper(cells[7].replace(/^tipo\s+pagamento:\s*/i, "")).slice(0, 60), totalCents: cents(cells[14]), items: [],
        },
      };
      bySale.set(saleNo, entry);
    }
    entry.sale.items.push({ code: cells[8].slice(0, 40), name: upper(cells[9]).slice(0, 160), qty: Number(cells[12].replace(",", ".")) || 0, cents: cents(cells[13]) });
  }
  const sales = [...bySale.values()].filter((entry) => entry.ok).map((entry) => entry.sale);
  const dates = lines.map((cells) => isoDate(cells[2])).sort();
  return {
    storeLabel: storeMatch ? upper(storeMatch[1].trim()) : "",
    rows: lines.length,
    salesTotal: bySale.size,
    sales,
    periodStart: dates[0] || "",
    periodEnd: dates[dates.length - 1] || "",
  };
}

const plain = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/** Loja do cabeçalho ("UNIGAMES RIOMAR") → loja cadastrada. PNWS = NORTH WAY. */
export function matchStore<T extends { id: string; name: string }>(label: string, stores: T[]): T | undefined {
  const wanted = plain(label).replace(/\bNORTH WAY\b/, "PNWS");
  if (!wanted) return undefined;
  return stores.find((store) => {
    const name = plain(store.name).replace(/\bNORTH WAY\b/, "PNWS");
    return name === wanted || name.includes(wanted) || wanted.includes(name);
  });
}

export const CONTACT_RESULTS = {
  contato_realizado: "CONTATO REALIZADO",
  sem_resposta: "SEM RESPOSTA",
  respondeu: "RESPONDEU",
  retorno_agendado: "RETORNO AGENDADO",
  venda_realizada: "VENDA REALIZADA",
  cliente_reativado: "CLIENTE REATIVADO (RECOMPRA CONFIRMADA)",
} as const;
export type ContactResult = keyof typeof CONTACT_RESULTS;

export const DEFAULT_SETTINGS = {
  inactiveDays: 180,
  historyMonths: 0, // 0 = guarda tudo
  message: "OLÁ, {NOME}! AQUI É DA UNIGAMES {LOJA}. TUDO BEM? ESTAMOS COM NOVIDADES PARA VOCÊ — POSSO TE MOSTRAR?",
};
export type FidelizaSettings = typeof DEFAULT_SETTINGS;

/** Data ISO "AAAA-MM-DD" deslocada em dias / meses (UTC, sem fuso). */
export function shiftDate(iso: string, { days = 0, months = 0 }) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (months) date.setUTCMonth(date.getUTCMonth() - months);
  if (days) date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
