import { isValidCpf } from "./br-documents";

// Assistência > Orçamentos — regras puras (sem banco), usadas pelas rotas de
// app/api/assistencia/** e testadas direto em tests/assistencia.test.mjs.
//
// Cada linha do orçamento guarda NOME e VALOR do defeito como texto/centavos
// (cópia), nunca uma referência ao cadastro: mudar a tabela de valores não
// altera orçamento salvo, e a edição nunca recebe um objeto onde espera texto
// (o app antigo travava com React #31 por guardar {label, description}).

// Categorias ficam na tabela assist_categories (aba CATEGORIAS, migration 0082).
// O orçamento guarda o NOME da categoria como texto (cópia), como o defeito.

// Textos padrão marcáveis no orçamento. Espelhados em ASSIST_OBSERVATIONS de
// public/estoque.html (o teste confere que são iguais). O orçamento salva uma
// CÓPIA do título e do texto, então trocar o texto aqui não muda os antigos.
export const ASSIST_OBSERVATIONS = [
  {
    key: "preventiva",
    title: "MANUTENÇÃO PREVENTIVA",
    text: "MANUTENÇÃO PREVENTIVA É A LIMPEZA INTERNA E EXTERNA, LUBRIFICAÇÃO DOS COMPONENTES REMOVENDO SUAS OXIDAÇÕES AO MÁXIMO, AUXILIANDO NA PROLONGAÇÃO DA VIDA ÚTIL DOS COMPONENTES E, C/A TROCA DA PASTA TÉRMICA SILVER DE ALTA RESISTÊNCIA / METAL LIQUIDO.",
  },
  {
    key: "novos_defeitos",
    title: "AVISO DE NOVOS DEFEITOS",
    text: "ATENÇÃO, EM CASO DE DETECÇÃO DE NOVOS DEFEITOS DOS QUAIS SÓ PODEM SER IDENTIFICADOS COM O ELETRÔNICO LIGADO APÓS A CORREÇÃO DESTE ORÇAMENTO, ESTAREMOS REFORMULANDO ESSE ORÇAMENTO. EX: DRIVE (FUNÇÃO P/ LEITURA CD/DVD), PORTAS USB’s, UNIDADE DE ARMAZENAMENTO, COOLER E ETC...",
  },
  {
    key: "garantia",
    title: "GARANTIA",
    text: "O SERVIÇO DESSE ORÇAMENTO CONTÉM GARANTIA DE 90 DIAS PELO CDC, Lei nº 8.078, NO ART 26.",
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

/** Nome de categoria em caixa alta (2 a 60 caracteres) ou "" se inválido. */
export function categoryName(value: unknown) {
  const name = upper(text(value, 60).replace(/\s+/g, " "));
  return name.length >= 2 ? name : "";
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
  /** Desconto em R$ (centavos) no item inteiro (qtd × valor), digitado no orçamento. */
  discountCents: number;
};

export type ParsedEquipment = {
  category: string;
  device: string;
  /** Modelo exato (celular/tablet, notebook, PC) — opcional. */
  model: string;
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
  /** Forma de CRÉDITO escolhida para aparecer no PDF ("" = nenhuma). */
  creditOptionId: string;
  totalCents: number;
};

type PricedLine = { defectName?: string; quantity: number; unitCents: number; discountCents?: number };

/** Valor do item já com o desconto em R$ digitado no orçamento. */
export function lineNetCents(line: PricedLine) {
  return line.quantity * line.unitCents - (line.discountCents || 0);
}

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
  return hasOtherService && isPreventive(line) ? lineNetCents(line) : 0;
}

/** Total SEMPRE calculado aqui (qtd × valor − desconto do item − desconto da preventiva), nunca vindo do navegador. */
export function equipmentSubtotal(equipment: { lines: PricedLine[] }) {
  return equipment.lines.reduce(
    (sum, line) => sum + lineNetCents(line) - preventiveDiscountCents(equipment, line),
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
    const rawDiscount = entry.discountCents;
    const discountCents = rawDiscount === null || rawDiscount === undefined || rawDiscount === "" ? 0 : cents(rawDiscount);
    if (discountCents === null) return { error: `${lineLabel}: DESCONTO INVÁLIDO.` };
    if (discountCents > quantity * unitCents) return { error: `${lineLabel}: O DESCONTO NÃO PODE SER MAIOR QUE O VALOR DO ITEM.` };
    lines.push({ defectName, description, quantity, unitCents, discountCents });
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
    const category = categoryName(item.category);
    if (!category) return { error: `${label}: ESCOLHA A CATEGORIA.` };
    const device = upper(text(item.device, 120));
    if (device.length < 2) return { error: `${label}: ESCOLHA O APARELHO.` };
    const parsed = parseLines(item.lines, label);
    if ("error" in parsed) return parsed;
    equipments.push({
      category,
      device,
      model: upper(text(item.model, 120)),
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
      creditOptionId: text(entry.creditOptionId, 80),
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
  category: string;
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
  const category = categoryName(entry.category);
  if (!category) return { error: "ESCOLHA A CATEGORIA." };
  const device = upper(text(entry.device, 120));
  if (device.length < 2) return { error: "INFORME O APARELHO." };
  const name = upper(text(entry.name, 160));
  if (name.length < 2) return { error: "INFORME O NOME DO DEFEITO." };
  const values = parseDefectValues(entry);
  if ("error" in values) return values;
  return { defect: { category, device, name, ...values } };
}

/** Violação de índice único no Postgres (23505) ou no SQLite dos testes. */
export function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /unique/i.test(message);
}

// ---------------------------------------------------------------------------
// Formas de pagamento (aba PAGAMENTOS). "always" aparece em todo orçamento
// (débito, dinheiro/Pix); "credit" só a escolhida no orçamento. Só desconto,
// nunca acréscimo (decisão do usuário). Percentual em centésimos (500 = 5%).
// ---------------------------------------------------------------------------
export const PAYMENT_KINDS = ["credit", "always"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const MAX_INSTALLMENTS = 24;

export type PaymentSnapshot = { id: string; kind: PaymentKind; label: string; discountBp: number; installments: number };

/** Valor total na forma de pagamento (desconto sobre o total, arredondado ao centavo). */
export function paymentAmountCents(totalCents: number, discountBp: number) {
  return Math.round((totalCents * (10000 - discountBp)) / 10000);
}

export function parsePaymentOption(body: unknown): { option: Omit<PaymentSnapshot, "id"> & { active: boolean } } | { error: string } {
  const entry = (body && typeof body === "object" ? body : {}) as JsonMap;
  const kind = entry.kind;
  if (kind !== "credit" && kind !== "always") return { error: "ESCOLHA O TIPO (CRÉDITO OU SEMPRE)." };
  const label = upper(text(entry.label, 160));
  if (label.length < 3) return { error: "INFORME A DESCRIÇÃO DA FORMA DE PAGAMENTO." };
  const discountBp = typeof entry.discountBp === "string" ? Number(entry.discountBp) : entry.discountBp ?? 0;
  if (typeof discountBp !== "number" || !Number.isInteger(discountBp) || discountBp < 0 || discountBp >= 10000) {
    return { error: "DESCONTO INVÁLIDO (0% A 99,99%)." };
  }
  const installments = kind === "credit"
    ? typeof entry.installments === "string" ? Number(entry.installments) : entry.installments
    : 1;
  if (typeof installments !== "number" || !Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
    return { error: `Nº DE PARCELAS INVÁLIDO (1 A ${MAX_INSTALLMENTS}).` };
  }
  const active = !(entry.active === false || entry.active === 0 || entry.active === "0");
  return { option: { kind, label, discountBp, installments, active } };
}

/** Lê o JSON de formas de pagamento gravado no orçamento (lista vazia se ausente/inválido). */
export function parseSavedPayments(raw: unknown): PaymentSnapshot[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object" && typeof item.label === "string")
      .map((item) => ({
        id: String(item.id || ""),
        kind: item.kind === "credit" ? "credit" : "always",
        label: String(item.label),
        discountBp: Number(item.discountBp) || 0,
        installments: Math.max(1, Number(item.installments) || 1),
      }));
  } catch {
    return [];
  }
}

// Aba CATEGORIAS: nome e se o orçamento pede o MODELO do aparelho.
export function parseCategory(body: unknown): { category: { name: string; asksModel: boolean; active: boolean } } | { error: string } {
  const entry = (body && typeof body === "object" ? body : {}) as JsonMap;
  const name = categoryName(entry.name);
  if (!name) return { error: "INFORME O NOME DA CATEGORIA." };
  const flag = (value: unknown) => value === true || value === 1 || value === "1";
  const active = !(entry.active === false || entry.active === 0 || entry.active === "0");
  return { category: { name, asksModel: flag(entry.asksModel), active } };
}
