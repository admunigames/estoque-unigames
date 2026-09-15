export type DocumentFolderId =
  | "garantia-produto"
  | "garantia-estendida"
  | "documentos-avulsos";

export type DocumentFolder = {
  id: DocumentFolderId;
  category: "certificates" | "loose";
  folder: "certificados" | "documentos_avulsos";
  subfolder: "garantia_produto" | "garantia_estendida" | "";
  label: string;
};

export type DocumentActor = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export type DocumentRow = {
  id: string;
  fileName: string;
  category: string;
  folder: string;
  subfolder: string;
  r2Key: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
};

const FOLDERS: Record<DocumentFolderId, DocumentFolder> = {
  "garantia-produto": {
    id: "garantia-produto",
    category: "certificates",
    folder: "certificados",
    subfolder: "garantia_produto",
    label: "Garantia de Produto",
  },
  "garantia-estendida": {
    id: "garantia-estendida",
    category: "certificates",
    folder: "certificados",
    subfolder: "garantia_estendida",
    label: "Garantia Estendida",
  },
  "documentos-avulsos": {
    id: "documentos-avulsos",
    category: "loose",
    folder: "documentos_avulsos",
    subfolder: "",
    label: "Documentos Avulsos",
  },
};

export function documentFolder(value: unknown): DocumentFolder | null {
  if (typeof value !== "string") return null;
  return FOLDERS[value as DocumentFolderId] ?? null;
}

export function safeDocumentText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function documentActor(request: Request): DocumentActor {
  return {
    id: safeDocumentText(request.headers.get("x-unigames-user-id"), 80),
    username: safeDocumentText(request.headers.get("x-unigames-username"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

export function canManageDocuments(actor: DocumentActor) {
  return actor.role === "admin" && actor.permissions.includes("documents_manage");
}

export function documentJson(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function documentSameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

export async function documentsBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  const bucket = (env as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) {
    throw new Error("O ARMAZENAMENTO DE DOCUMENTOS NÃO ESTÁ DISPONÍVEL.");
  }
  return bucket;
}

// Mantidos com o nome histórico "PDF" porque é assim que o restante do
// projeto (rotas de anexo, staging em R2) importa estas constantes — o
// conteúdo aceito deixou de ser exclusivo de PDF, só o tamanho/tamanho de
// pedaço do upload em partes continuam os mesmos.
export const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const PDF_CHUNK_SIZE = 512 * 1024;
export const MAX_PDF_SIZE = 25 * 1024 * 1024;

function hasControlChar(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function safeExtension(fileName: string) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(fileName);
  return match ? match[1].toLowerCase() : "";
}

// Sanitiza o nome do arquivo para uso como chave no R2 (sem path traversal,
// sem caracteres fora de a-z0-9._-), preservando a extensão original em vez
// de forçar ".pdf" — qualquer tipo de anexo passa por aqui.
export function safeR2FileName(fileName: string) {
  const extension = safeExtension(fileName);
  const withoutExtension = extension ? fileName.slice(0, -(extension.length + 1)) : fileName;
  const base = withoutExtension
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return extension ? `${base || "arquivo"}.${extension}` : base || "arquivo";
}

export function validAttachmentName(fileName: string) {
  return (
    fileName.length > 0 &&
    fileName.length <= 180 &&
    !fileName.includes("/") &&
    !fileName.includes("\\") &&
    !hasControlChar(fileName)
  );
}

export function contentDisposition(fileName: string, download: boolean) {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_")
    .slice(0, 160) || "arquivo";
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
