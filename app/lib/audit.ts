// Auditoria: registro central de toda gravação (POST/PUT/PATCH/DELETE) em
// /api/*, feito pelo Worker depois que a rota responde com sucesso. Lógica
// pura (sem imports) para o Worker e os testes usarem direto.

const MODULE_LABELS: [string, string][] = [
  ["/api/admin/users", "USUÁRIOS"],
  ["/api/compras-novo", "COMPRAS"],
  ["/api/compras", "COMPRAS (ANTIGO)"],
  ["/api/finance/payables", "CONTAS A PAGAR"],
  ["/api/finance/invoices", "NF / DUPLICATAS"],
  ["/api/finance/expenses", "DESPESAS"],
  ["/api/finance/suppliers", "FORNECEDORES"],
  ["/api/finance", "FINANCEIRO"],
  ["/api/commercial/academy", "TREINAMENTO"],
  ["/api/commercial", "COMERCIAL"],
  ["/api/controle-gd", "CONTROLE DE GORDURAS"],
  ["/api/gorduras-assistencia", "CONTROLE GORDURAS ASSISTÊNCIA"],
  ["/api/relatorio-nf", "RELATÓRIO NF"],
  ["/api/divergences", "DIVERGÊNCIAS"],
  ["/api/inventario", "INVENTÁRIO"],
  ["/api/assistencia/ordens-servico", "ORDENS DE SERVIÇO"],
  ["/api/assistencia/precos", "CONSULTA DE PREÇOS"],
  ["/api/assistencia/estoque", "ESTOQUE ASSISTÊNCIA"],
  ["/api/assistencia/rma", "RMA"],
  ["/api/assistencia", "ASSISTÊNCIA"],
  ["/api/captures", "CAPTAÇÃO"],
  ["/api/auditoria-operacional", "AUDITORIA OPERACIONAL"],
  ["/api/checklists", "MISSÕES"],
  ["/api/routines", "MISSÕES"],
  ["/api/missions", "MISSÕES"],
  ["/api/documents", "DOCUMENTOS"],
  ["/api/instructions", "INSTRUÇÕES"],
  ["/api/inputs", "ENTRADA"],
  ["/api/outputs", "SAÍDAS"],
  ["/api/loans", "APARELHOS DE EMPRÉSTIMO"],
  ["/api/obras", "OBRAS"],
  ["/api/os-notes", "NOTAS DE O.S."],
  ["/api/pdv-requests", "ALTERAÇÕES PDV"],
  ["/api/product-catalog", "BASE DE DADOS"],
  ["/api/supplies", "INSUMOS"],
  ["/api/shared-state", "CADASTROS"],
  ["/api/backup", "BACKUP"],
  ["/api/hr-rh/onboarding", "RH - ONBOARDING"],
  ["/api/hr-rh/offboarding", "RH - DESLIGAMENTO"],
  ["/api/hr-store-tracking/leader-pdi", "RH - PDI"],
  ["/api/hr-", "RH"],
];

// Gravações que não interessam à auditoria (preferência de tema, inscrição
// de notificação, sessão).
// Também ficam de fora a batida do player do Onboarding (a cada ~10 s) e as
// partes do envio de vídeo — o registro fica no cadastro/conclusão.
const IGNORED_PREFIXES = [
  "/api/preferences", "/api/push", "/api/session", "/api/live", "/api/health",
  "/api/hr-rh/onboarding/progress", "/api/hr-rh/onboarding/upload-part",
];

export function shouldAudit(method: string, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false;
  if (!path.startsWith("/api/")) return false;
  return !IGNORED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?"));
}

export function auditModule(path: string): string {
  // Prefixo terminado em "-" (ex.: "/api/hr-") vale para todas as rotas que começam assim.
  const hit = MODULE_LABELS.find(([prefix]) =>
    prefix.endsWith("-") ? path.startsWith(prefix) : path === prefix || path.startsWith(prefix + "/"));
  if (hit) return hit[1];
  const segment = path.split("/")[2] || "";
  return segment.toUpperCase().replace(/-/g, " ");
}

const ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{8,40}|\d{3,}|[A-Za-z0-9_-]{20,})$/i;

/** Primeiro trecho do caminho com cara de id (uuid, cuid, número) ou o id devolvido pela rota. */
export function auditRecordId(path: string, responseBody?: unknown): string {
  const fromPath = path.split("/").slice(3).find((segment) => ID_PATTERN.test(segment));
  if (fromPath) return decodeURIComponent(fromPath).slice(0, 80);
  const body = responseBody as Record<string, unknown> | null | undefined;
  const id = body && (body.id ?? body.orderId ?? body.requestId);
  return typeof id === "string" || typeof id === "number" ? String(id).slice(0, 80) : "";
}

const ACTION_BY_TAIL: [RegExp, string][] = [
  [/attachments?|files?|upload|photo|image|comprovante|receipt/i, "ANEXO"],
  [/status|respond|store-reply|winner|receive|done|approve|reject|cancel|confirm|finaliz|close|reopen/i, "STATUS"],
  [/bulk/i, "EM LOTE"],
];

/** CADASTROU / ALTEROU / EXCLUIU + o tipo da ação quando o caminho diz (ANEXO, STATUS, EM LOTE). */
export function auditAction(method: string, path: string): string {
  const upper = method.toUpperCase();
  const base = upper === "DELETE" ? "EXCLUIU" : upper === "POST" ? "CADASTROU" : "ALTEROU";
  const tail = path.split("?")[0].split("/").slice(3).filter((segment) => !ID_PATTERN.test(segment)).join("/");
  const kind = ACTION_BY_TAIL.find(([pattern]) => pattern.test(tail));
  if (!kind) return base;
  if (kind[1] === "ANEXO") return upper === "DELETE" ? "EXCLUIU ANEXO" : "ANEXO";
  if (kind[1] === "STATUS") return "STATUS / ANDAMENTO";
  return base + " EM LOTE";
}

// Campos do corpo que ajudam a reconhecer o registro. Nunca senha, token,
// documento ou cartão (lista branca: só estes entram).
const SUMMARY_KEYS = [
  "name", "title", "description", "productName", "productCode", "saleCode", "sellerName", "supplierName",
  "storeName", "companyName", "employeeName", "fullName", "displayName", "username", "status", "action",
  "month", "date", "entryDate", "dueDate", "key", "notes", "reason",
];

export function auditSummary(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) parts.push(`${key}: ${value.trim().slice(0, 80)}`);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}: ${value}`);
    if (parts.length >= 4) break;
  }
  for (const listKey of ["ids", "items", "entries"]) {
    const list = record[listKey];
    if (Array.isArray(list) && list.length) parts.push(`${listKey}: ${list.length}`);
  }
  return parts.join(" · ").slice(0, 300);
}
