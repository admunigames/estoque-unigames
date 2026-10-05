import { isValidCpf } from "./br-documents";

// Assistência > Orçamentos — regras puras (sem banco), usadas pelas rotas de
// app/api/assistencia/** e testadas direto em tests/assistencia.test.mjs.
//
// Cada linha do orçamento guarda NOME e VALOR do defeito como texto/centavos
// (cópia), nunca uma referência ao cadastro: mudar a tabela de valores não
// altera orçamento salvo, e a edição nunca recebe um objeto onde espera texto
// (o app antigo travava com React #31 por guardar {label, description}).

export const ASSIST_CATEGORIES = ["CONSOLES", "CONTROLES", "NOTEBOOKS E COMPUTADORES"] as const;
export type AssistCategory = (typeof ASSIST_CATEGORIES)[number];

// Textos padrão marcáveis no orçamento. Espelhados em ASSIST_OBSERVATIONS de
// public/estoque.html (o teste confere que são iguais). O orçamento salva uma
// CÓPIA do título e do texto, então trocar o texto aqui não muda os antigos.
export const ASSIST_OBSERVATIONS = [
  {
    key: "preventiva",
    title: "MANUTENÇÃO PREVENTIVA",
    text: "Manutenção preventiva é a limpeza interna e externa, lubrificação dos componentes removendo suas oxidações ao máximo, auxiliando na prolongação da vida útil dos componentes e troca da pasta térmica.",
  },
  {
    key: "novos_defeitos",
    title: "AVISO DE NOVOS DEFEITOS",
    text: "Em caso de detecção de novos defeitos identificados somente após correção deste orçamento, será realizado novo orçamento.",
  },
  {
    key: "garantia",
    title: "GARANTIA",
    text: "O serviço deste orçamento contém garantia de 90 dias pelo CDC.",
  },
] as const;

export type SavedObservation = { key: string; title: string; text: string };

export const MAX_EQUIPMENTS = 20;
export const MAX_LINES_PER_EQUIPMENT = 50;
export const MAX_QUANTITY = 999;
export const MAX_UNIT_CENTS = 100_000_000; // R$ 1.000.000,00

type JsonMap = Record<string, unknown>;

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function upper(value: string) {
  return value.toLocaleUpperCase("pt-BR");
}

export function onlyDigits(value: unknown) {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

export function isAssistCategory(value: unknown): value is AssistCategory {
  return typeof value === "string" && (ASSIST_CATEGORIES as readonly string[]).includes(value);
}

/** OS do PDV: sem espaços, em caixa alta (é o que garante o ÚNICO). */
export function normalizeOsNumber(value: unknown) {
  return upper(text(value, 40).replace(/\s+/g, ""));
}

export function isValidOsNumber(value: string) {
  return /^[0-9A-Z][0-9A-Z./-]{0,29}$/.test(value);
}

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Centavos inteiros, 0 ou mais; string vazia/nula = não informado (null). */
export function cents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_UNIT_CENTS
    ? parsed
    : null;
}

export type ParsedLine = {
  defectName: string;
  description: string;
  quantity: number;
  unitCents: number;
};

export type ParsedEquipment = {
  category: AssistCategory;
  device: string;
  serialNumber: string;
  service: string;
  lines: ParsedLine[];
};

export type ParsedQuote = {
  osNumber: string;
  companyId: string;
  entryDate: string;
  clientName: string;
  clientCpf: string;
  clientPhone: string;
  clientAddress: string;
  observations: SavedObservation[];
  extraNotes: string;
  equipments: ParsedEquipment[];
  totalCents: number;
};

type PricedLine = { defectName?: string; quantity: number; unitCents: number };

/** Defeito da tabela com PREVENTIVA no nome (ex.: "PREVENTIVA", "MANUTENÇÃO PREVENTIVA"). */
export function isPreventive(line: { defectName?: string }) {
  return Boolean(line.defectName && line.defectName.includes("PREVENTIVA"));
}

/**
 * A preventiva entra como DESCONTO (sai de graça) quando o equipamento tem
 * outro serviço: aparece com o valor e uma linha "DESCONTO ..." igual, sem
 * somar no total. Preventiva sozinha no equipamento é cobrada normalmente.
 */
export function preventiveDiscountCents(equipment: { lines: PricedLine[] }, line: PricedLine) {
  const hasOtherService = equipment.lines.some((other) => !isPreventive(other));
  return hasOtherService && isPreventive(line) ? line.quantity * line.unitCents : 0;
}

/** Total SEMPRE calculado aqui (qtd × valor unitário − desconto da preventiva), nunca vindo do navegador. */
export function equipmentSubtotal(equipment: { lines: PricedLine[] }) {
  return equipment.lines.reduce(
    (sum, line) => sum + line.quantity * line.unitCents - preventiveDiscountCents(equipment, line),
    0,
  );
}

export function quoteTotal(equipments: Array<{ lines: PricedLine[] }>) {
  return equipments.reduce((sum, equipment) => sum + equipmentSubtotal(equipment), 0);
}

function parseLines(raw: unknown, label: string): { lines: ParsedLine[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: `${label}: INCLUA PELO MENOS UM DEFEITO OU ITEM AVULSO.` };
  }
  if (raw.length > MAX_LINES_PER_EQUIPMENT) {
    return { error: `${label}: MÁXIMO DE ${MAX_LINES_PER_EQUIPMENT} ITENS POR EQUIPAMENTO.` };
  }
  const lines: ParsedLine[] = [];
  for (const [index, value] of raw.entries()) {
    const entry = (value && typeof value === "object" ? value : {}) as JsonMap;
    const defectName = upper(text(entry.defectName, 160));
    const description = text(entry.description, 600);
    const lineLabel = `${label} · ${defectName || `ITEM ${index + 1}`}`;
    if (!defectName && description.length < 2) {
      return { error: `${lineLabel}: DESCREVA O ITEM AVULSO.` };
    }
    const quantity = typeof entry.quantity === "string" ? Number(entry.quantity) : entry.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return { error: `${lineLabel}: QUANTIDADE INVÁLIDA (1 A ${MAX_QUANTITY}).` };
    }
    const unitCents = cents(entry.unitCents);
    if (unitCents === null) return { error: `${lineLabel}: INFORME O VALOR UNITÁRIO.` };
    lines.push({ defectName, description, quantity, unitCents });
  }
  return { lines };
}

/** Valida o orçamento enviado (criação e edição). companyId é conferido na rota. */
export function parseQuote(body: unknown): { quote: ParsedQuote } | { error: string } {
  const entry = (body && typeof body === "object" ? body : {}) as JsonMap;
  const companyId = text(entry.companyId, 80);
  if (!companyId) return { error: "ESCOLHA A LOJA." };
  const osNumber = normalizeOsNumber(entry.osNumber);
  if (!osNumber) return { error: "INFORME O Nº DA OS." };
  if (!isValidOsNumber(osNumber)) return { error: "Nº DA OS INVÁLIDO (USE SÓ NÚMEROS E LETRAS)." };
  const entryDate = text(entry.entryDate, 10);
  if (!isDateOnly(entryDate)) return { error: "INFORME A DATA DE ENTRADA." };

  const clientName = upper(text(entry.clientName, 160));
  if (clientName.length < 2) return { error: "INFORME O NOME DO CLIENTE." };
  const clientPhone = onlyDigits(entry.clientPhone);
  if (clientPhone.length < 10 || clientPhone.length > 11) {
    return { error: "INFORME O TELEFONE DO CLIENTE COM DDD." };
  }
  const clientCpf = onlyDigits(entry.clientCpf);
  if (clientCpf && !isValidCpf(clientCpf)) return { error: "CPF DO CLIENTE INVÁLIDO." };
  const clientAddress = text(entry.clientAddress, 400);

  const keys = Array.isArray(entry.observations) ? entry.observations : [];
  const observations: SavedObservation[] = ASSIST_OBSERVATIONS
    .filter((observation) => keys.includes(observation.key))
    .map(({ key, title, text: body }) => ({ key, title, text: body }));
  const extraNotes = text(entry.extraNotes, 2000);

  const rawEquipments = entry.equipments;
  if (!Array.isArray(rawEquipments) || !rawEquipments.length) {
    return { error: "INCLUA PELO MENOS UM EQUIPAMENTO." };
  }
  if (rawEquipments.length > MAX_EQUIPMENTS) {
    return { error: `MÁXIMO DE ${MAX_EQUIPMENTS} EQUIPAMENTOS POR ORÇAMENTO.` };
  }
  const equipments: ParsedEquipment[] = [];
  for (const [index, value] of rawEquipments.entries()) {
    const item = (value && typeof value === "object" ? value : {}) as JsonMap;
    const label = `EQUIPAMENTO ${index + 1}`;
    const category = item.category;
    if (!isAssistCategory(category)) return { error: `${label}: ESCOLHA A CATEGORIA.` };
    const device = upper(text(item.device, 120));
    if (device.length < 2) return { error: `${label}: ESCOLHA O APARELHO.` };
    const parsed = parseLines(item.lines, label);
    if ("error" in parsed) return parsed;
    equipments.push({
      category,
      device,
      serialNumber: upper(text(item.serialNumber, 80)),
      service: text(item.service, 600),
      lines: parsed.lines,
    });
  }

  return {
    quote: {
      osNumber,
      companyId,
      entryDate,
      clientName,
      clientCpf,
      clientPhone,
      clientAddress,
      observations,
      extraNotes,
      equipments,
      totalCents: quoteTotal(equipments),
    },
  };
}

/** Lê o JSON de observações gravado; qualquer coisa fora do formato vira lista vazia. */
export function parseSavedObservations(raw: unknown): SavedObservation[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        key: typeof item.key === "string" ? item.key : "",
        title: typeof item.title === "string" ? item.title : "",
        text: typeof item.text === "string" ? item.text : "",
      }))
      .filter((item) => item.title || item.text);
  } catch {
    return [];
  }
}

export type ParsedDefect = {
  category: AssistCategory;
  device: string;
  name: string;
  minCents: number;
  maxCents: number;
  quoteOnly: boolean;
};

/**
 * Valores da tabela: "SOB ORÇAMENTO" grava 0/0 (o valor é sempre digitado no
 * orçamento); valor único = mínimo e máximo iguais (máximo vazio → mínimo).
 */
export function parseDefectValues(entry: JsonMap): { minCents: number; maxCents: number; quoteOnly: boolean } | { error: string } {
  const quoteOnly = entry.quoteOnly === true || entry.quoteOnly === 1 || entry.quoteOnly === "1";
  if (quoteOnly) return { minCents: 0, maxCents: 0, quoteOnly };
  const minCents = cents(entry.minCents);
  if (minCents === null) return { error: "INFORME O VALOR MÍNIMO (OU MARQUE SOB ORÇAMENTO)." };
  const rawMax = entry.maxCents;
  const maxCents = rawMax === null || rawMax === undefined || rawMax === "" ? minCents : cents(rawMax);
  if (maxCents === null) return { error: "VALOR MÁXIMO INVÁLIDO." };
  if (maxCents < minCents) return { error: "O VALOR MÁXIMO NÃO PODE SER MENOR QUE O MÍNIMO." };
  return { minCents, maxCents, quoteOnly };
}

export function parseNewDefect(body: unknown): { defect: ParsedDefect } | { error: string } {
  const entry = (body && typeof body === "object" ? body : {}) as JsonMap;
  if (!isAssistCategory(entry.category)) return { error: "ESCOLHA A CATEGORIA." };
  const device = upper(text(entry.device, 120));
  if (device.length < 2) return { error: "INFORME O APARELHO." };
  const name = upper(text(entry.name, 160));
  if (name.length < 2) return { error: "INFORME O NOME DO DEFEITO." };
  const values = parseDefectValues(entry);
  if ("error" in values) return values;
  return { defect: { category: entry.category, device, name, ...values } };
}

/** Violação de índice único no Postgres (23505) ou no SQLite dos testes. */
export function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /unique/i.test(message);
}
