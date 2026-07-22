const NOTION_VERSION = "2026-03-11";
const DEFAULT_DATA_SOURCE_ID = "3281f04e-8950-8046-937e-000bcedd0246";

type JsonMap = Record<string, unknown>;

export type UploadedNotionFile = {
  id: string;
  name: string;
};

export type PurchaseInput = {
  fornecedor?: string;
  loja?: string;
  responsavelId?: string;
  dataPedido?: string;
  previsao?: string;
  dataRecebimento?: string;
  movimentacaoSistema?: string;
  divisao?: string;
  statusDivisao?: string;
  status?: string;
  arquivos?: {
    pedido?: UploadedNotionFile[];
    notaFiscal?: UploadedNotionFile[];
  };
};

export class NotionApiError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
  }
}

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textContent(value: unknown): string {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      return typeof record.plain_text === "string" ? record.plain_text : "";
    })
    .join("");
}

function property(page: JsonMap, name: string): JsonMap {
  return asRecord(asRecord(page.properties)[name]);
}

function dateValue(page: JsonMap, name: string): string {
  const date = asRecord(property(page, name).date);
  return typeof date.start === "string" ? date.start : "";
}

function optionValue(page: JsonMap, name: string, kind: "status" | "select"): string {
  const option = asRecord(property(page, name)[kind]);
  return typeof option.name === "string" ? option.name : "";
}

function fileItems(page: JsonMap, name: string) {
  return asArray(property(page, name).files).map((value) => {
    const item = asRecord(value);
    const type = typeof item.type === "string" ? item.type : "";
    const source = asRecord(item[type]);
    const url = typeof source.url === "string" ? source.url : "";
    return {
      name: typeof item.name === "string" ? item.name : "ARQUIVO",
      type,
      url,
    };
  });
}

function peopleItems(page: JsonMap, name: string) {
  return asArray(property(page, name).people).map((value) => {
    const person = asRecord(value);
    const personDetail = asRecord(person.person);
    return {
      id: typeof person.id === "string" ? person.id : "",
      name: typeof person.name === "string" ? person.name : "",
      email: typeof personDetail.email === "string" ? personDetail.email : "",
      avatarUrl: typeof person.avatar_url === "string" ? person.avatar_url : "",
    };
  });
}

export function normalizePurchase(value: unknown) {
  const page = asRecord(value);
  return {
    id: typeof page.id === "string" ? page.id : "",
    url: typeof page.url === "string" ? page.url : "",
    fornecedor: textContent(property(page, "FORNECEDOR").title),
    loja: textContent(property(page, "LOJA").rich_text),
    dataPedido: dateValue(page, "DATA DO PEDIDO"),
    previsao: dateValue(page, "PREVISÃO"),
    responsaveis: peopleItems(page, "RESPONSÁVEL"),
    dataRecebimento: dateValue(page, "DATA DO RECEBIMENTO"),
    divisao: textContent(property(page, "DIVISÃO").rich_text),
    statusDivisao: optionValue(page, "STATUS DA DIVISÃO", "select"),
    arquivoPedido: fileItems(page, "ARQUIVO DO PEDIDO"),
    notaFiscal: fileItems(page, "NOTA FISCAL"),
    movimentacaoSistema: dateValue(page, "MOVIMENTAÇÃO EM SISTEMA"),
    status: optionValue(page, "STATUS", "status"),
    createdTime: typeof page.created_time === "string" ? page.created_time : "",
    lastEditedTime:
      typeof page.last_edited_time === "string" ? page.last_edited_time : "",
  };
}

function richText(content: string) {
  return content
    ? [{ type: "text", text: { content: content.slice(0, 2000) } }]
    : [];
}

function title(content: string) {
  return content
    ? [{ type: "text", text: { content: content.slice(0, 200) } }]
    : [];
}

function date(start: string) {
  return start ? { start } : null;
}

const PURCHASE_STATUSES = new Set(["Não iniciado", "Em andamento", "Concluído"]);
const DIVISION_STATUSES = new Set([
  "FALTA DIVISÃO",
  "AGUARDANDO APROVAÇÃO",
  "ENVIAR DIVISÃO A LOJA",
  "FALTANDO ENVIO COMPLETO DA DIVISÃO",
  "CONCLUÍDO",
]);

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uploadedFiles(files: UploadedNotionFile[] | undefined) {
  return (files ?? [])
    .filter((file) => file && typeof file.id === "string" && file.id)
    .map((file) => ({
      type: "file_upload",
      file_upload: { id: file.id },
      name: safeString(file.name) || "ARQUIVO",
    }));
}

export function parsePurchaseInput(value: unknown): PurchaseInput {
  const payload = asRecord(value);
  const files = asRecord(payload.arquivos);

  const parseUploads = (candidate: unknown): UploadedNotionFile[] =>
    asArray(candidate)
      .map((item) => {
        const file = asRecord(item);
        return { id: safeString(file.id), name: safeString(file.name) };
      })
      .filter((file) => file.id);

  return {
    fornecedor: safeString(payload.fornecedor),
    loja: safeString(payload.loja),
    responsavelId: safeString(payload.responsavelId),
    dataPedido: safeString(payload.dataPedido),
    previsao: safeString(payload.previsao),
    dataRecebimento: safeString(payload.dataRecebimento),
    movimentacaoSistema: safeString(payload.movimentacaoSistema),
    divisao: safeString(payload.divisao),
    statusDivisao: safeString(payload.statusDivisao),
    status: safeString(payload.status),
    arquivos: {
      pedido: parseUploads(files.pedido),
      notaFiscal: parseUploads(files.notaFiscal),
    },
  };
}

export function buildPurchaseProperties(input: PurchaseInput) {
  const fornecedor = safeString(input.fornecedor);
  if (!fornecedor) {
    throw new NotionApiError("INFORME O FORNECEDOR.", 400);
  }

  const status = PURCHASE_STATUSES.has(safeString(input.status))
    ? safeString(input.status)
    : "Não iniciado";
  const divisionStatus = DIVISION_STATUSES.has(safeString(input.statusDivisao))
    ? safeString(input.statusDivisao)
    : "";

  const properties: JsonMap = {
    FORNECEDOR: { type: "title", title: title(fornecedor) },
    LOJA: { type: "rich_text", rich_text: richText(safeString(input.loja)) },
    "DATA DO PEDIDO": { type: "date", date: date(safeString(input.dataPedido)) },
    PREVISÃO: { type: "date", date: date(safeString(input.previsao)) },
    RESPONSÁVEL: {
      type: "people",
      people: input.responsavelId ? [{ id: safeString(input.responsavelId) }] : [],
    },
    "DATA DO RECEBIMENTO": {
      type: "date",
      date: date(safeString(input.dataRecebimento)),
    },
    DIVISÃO: {
      type: "rich_text",
      rich_text: richText(safeString(input.divisao)),
    },
    "STATUS DA DIVISÃO": {
      type: "select",
      select: divisionStatus ? { name: divisionStatus } : null,
    },
    "MOVIMENTAÇÃO EM SISTEMA": {
      type: "date",
      date: date(safeString(input.movimentacaoSistema)),
    },
    STATUS: { type: "status", status: { name: status } },
  };

  const orderFiles = uploadedFiles(input.arquivos?.pedido);
  const invoiceFiles = uploadedFiles(input.arquivos?.notaFiscal);
  if (orderFiles.length) {
    properties["ARQUIVO DO PEDIDO"] = { type: "files", files: orderFiles };
  }
  if (invoiceFiles.length) {
    properties["NOTA FISCAL"] = { type: "files", files: invoiceFiles };
  }

  return properties;
}

function writableExistingFiles(value: unknown) {
  return asArray(value)
    .map((candidate) => {
      const item = asRecord(candidate);
      const type = typeof item.type === "string" ? item.type : "";
      const name = typeof item.name === "string" ? item.name : "ARQUIVO";
      if (type === "external") {
        const url = asRecord(item.external).url;
        return typeof url === "string"
          ? { type: "external", name, external: { url } }
          : null;
      }
      if (type === "file") {
        const file = asRecord(item.file);
        return typeof file.url === "string"
          ? { type: "file", name, file: { url: file.url } }
          : null;
      }
      if (type === "file_upload") {
        const id = asRecord(item.file_upload).id;
        return typeof id === "string"
          ? { type: "file_upload", name, file_upload: { id } }
          : null;
      }
      return null;
    })
    .filter(Boolean);
}

export function appendUploadedFiles(
  pageValue: unknown,
  properties: JsonMap,
  input: PurchaseInput,
) {
  const page = asRecord(pageValue);
  const pageProperties = asRecord(page.properties);
  const append = (
    propertyName: "ARQUIVO DO PEDIDO" | "NOTA FISCAL",
    files: UploadedNotionFile[] | undefined,
  ) => {
    if (!files?.length) return;
    const existing = writableExistingFiles(asRecord(pageProperties[propertyName]).files);
    properties[propertyName] = {
      type: "files",
      files: [...existing, ...uploadedFiles(files)],
    };
  };

  append("ARQUIVO DO PEDIDO", input.arquivos?.pedido);
  append("NOTA FISCAL", input.arquivos?.notaFiscal);
}

export function notionDataSourceId() {
  return process.env.NOTION_DATA_SOURCE_ID?.trim() || DEFAULT_DATA_SOURCE_ID;
}

function notionToken() {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) {
    throw new NotionApiError(
      "A CONEXÃO SEGURA COM O NOTION AINDA NÃO FOI CONFIGURADA.",
      503,
    );
  }
  return token;
}

function notionErrorMessage(status: number, response: JsonMap) {
  if (status === 401) return "A CREDENCIAL DO NOTION É INVÁLIDA OU EXPIROU.";
  if (status === 403)
    return "A INTEGRAÇÃO DO NOTION NÃO TEM PERMISSÃO PARA ESTA OPERAÇÃO.";
  if (status === 404)
    return "A BASE CONTROLE DE COMPRAS NÃO ESTÁ COMPARTILHADA COM A INTEGRAÇÃO.";
  if (status === 429)
    return "O NOTION LIMITOU TEMPORARIAMENTE AS CONSULTAS. TENTE NOVAMENTE EM INSTANTES.";
  const message = typeof response.message === "string" ? response.message : "";
  return message || "O NOTION NÃO CONSEGUIU CONCLUIR A OPERAÇÃO.";
}

export async function notionRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${notionToken()}`);
  headers.set("Notion-Version", NOTION_VERSION);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers,
  });
  let data: unknown = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new NotionApiError(
      notionErrorMessage(response.status, asRecord(data)),
      response.status,
    );
  }
  return data;
}

export function unauthorizedResponse(request: Request) {
  const hostname = new URL(request.url).hostname;
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  if (local || request.headers.get("oai-authenticated-user-email")) return null;
  return Response.json({ error: "ACESSO NÃO AUTORIZADO." }, { status: 401 });
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof NotionApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json(
    { error: "NÃO FOI POSSÍVEL CONCLUIR A OPERAÇÃO." },
    { status: 500 },
  );
}
