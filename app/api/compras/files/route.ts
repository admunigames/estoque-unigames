import {
  apiErrorResponse,
  NotionApiError,
  notionRequest,
  unauthorizedResponse,
} from "../../../lib/notion";

type JsonMap = Record<string, unknown>;

type StagedUpload = {
  fileName: string;
  contentType: string;
  fileSize: number;
  numberOfParts: number;
  createdAt: string;
};

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : {};
}

const TRANSPORT_CHUNK_SIZE = 512 * 1024;
const NOTION_CHUNK_SIZE = 5 * 1024 * 1024;
const TRANSPORT_PARTS_PER_NOTION_PART =
  NOTION_CHUNK_SIZE / TRANSPORT_CHUNK_SIZE;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_SINGLE_PART_SIZE = 20 * 1024 * 1024;
const UPLOAD_PREFIX = "purchase-uploads";
const ALLOWED_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "text/plain",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "txt",
  "json",
  "doc",
  "docx",
  "xls",
  "xlsx",
]);

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function sessionIdIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function fileIsSupported(fileName: string, contentType: string) {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return (
    ALLOWED_EXTENSIONS.has(extension) &&
    (!contentType || ALLOWED_TYPES.has(contentType))
  );
}

function fileValidationResponse(
  fileName: string,
  contentType: string,
  fileSize: number,
) {
  if (!fileName || !Number.isInteger(fileSize) || fileSize <= 0) {
    return Response.json(
      { error: "SELECIONE UM ARQUIVO VÁLIDO." },
      { status: 400 },
    );
  }
  if (new TextEncoder().encode(fileName).byteLength > 900) {
    return Response.json(
      { error: "O NOME DO ARQUIVO É MUITO LONGO." },
      { status: 400 },
    );
  }
  if (fileSize > MAX_FILE_SIZE) {
    return Response.json(
      { error: "O ARQUIVO DEVE TER NO MÁXIMO 100 MB." },
      { status: 413 },
    );
  }
  if (!fileIsSupported(fileName, contentType)) {
    return Response.json(
      { error: "FORMATO DE ARQUIVO NÃO SUPORTADO." },
      { status: 400 },
    );
  }
  return null;
}

async function uploadsBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  const bucket = (env as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) {
    throw new NotionApiError(
      "O ARMAZENAMENTO TEMPORÁRIO DE DOCUMENTOS NÃO ESTÁ DISPONÍVEL.",
      503,
    );
  }
  return bucket;
}

function uploadPrefix(sessionId: string) {
  return `${UPLOAD_PREFIX}/${sessionId}`;
}

function metadataKey(sessionId: string) {
  return `${uploadPrefix(sessionId)}/metadata.json`;
}

function partKey(sessionId: string, partNumber: number) {
  return `${uploadPrefix(sessionId)}/parts/${String(partNumber).padStart(4, "0")}`;
}

async function readMetadata(bucket: R2Bucket, sessionId: string) {
  const object = await bucket.get(metadataKey(sessionId));
  if (!object) {
    throw new NotionApiError(
      "O ENVIO DO ARQUIVO EXPIROU. SELECIONE-O NOVAMENTE.",
      410,
    );
  }
  return JSON.parse(await object.text()) as StagedUpload;
}

async function removeStagedUpload(bucket: R2Bucket, sessionId: string) {
  const listed = await bucket.list({
    prefix: `${uploadPrefix(sessionId)}/`,
    limit: 1000,
  });
  const keys = listed.objects.map((object) => object.key);
  if (keys.length) await bucket.delete(keys);
}

async function createStagedUpload(payload: JsonMap) {
  const fileName = textValue(payload.fileName);
  const contentType = textValue(payload.contentType);
  const fileSize = numberValue(payload.fileSize);
  const numberOfParts = numberValue(payload.numberOfParts);
  const invalidFile = fileValidationResponse(fileName, contentType, fileSize);
  if (invalidFile) return invalidFile;

  const expectedParts = Math.max(1, Math.ceil(fileSize / TRANSPORT_CHUNK_SIZE));
  if (
    !Number.isInteger(numberOfParts) ||
    numberOfParts !== expectedParts
  ) {
    return Response.json(
      { error: "A DIVISÃO DO ARQUIVO É INVÁLIDA. SELECIONE-O NOVAMENTE." },
      { status: 400 },
    );
  }

  const sessionId = crypto.randomUUID();
  const metadata: StagedUpload = {
    fileName,
    contentType: contentType || "application/octet-stream",
    fileSize,
    numberOfParts,
    createdAt: new Date().toISOString(),
  };
  const bucket = await uploadsBucket();
  await bucket.put(metadataKey(sessionId), JSON.stringify(metadata), {
    httpMetadata: { contentType: "application/json" },
  });

  return Response.json(
    { session: { id: sessionId, name: fileName, numberOfParts } },
    { status: 201 },
  );
}

async function storeTransportChunk(request: Request) {
  const sessionId = textValue(request.headers.get("x-purchase-upload-id"));
  const partNumber = numberValue(
    request.headers.get("x-purchase-part-number"),
  );
  if (
    !sessionIdIsValid(sessionId) ||
    !Number.isInteger(partNumber) ||
    partNumber < 1
  ) {
    return Response.json(
      { error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." },
      { status: 400 },
    );
  }

  const bucket = await uploadsBucket();
  const metadata = await readMetadata(bucket, sessionId);
  if (partNumber > metadata.numberOfParts) {
    return Response.json(
      { error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." },
      { status: 400 },
    );
  }

  const bytes = await request.arrayBuffer();
  const expectedSize =
    partNumber === metadata.numberOfParts
      ? metadata.fileSize -
        (metadata.numberOfParts - 1) * TRANSPORT_CHUNK_SIZE
      : TRANSPORT_CHUNK_SIZE;
  if (bytes.byteLength !== expectedSize || bytes.byteLength > TRANSPORT_CHUNK_SIZE) {
    return Response.json(
      { error: "UMA PARTE DO ARQUIVO CHEGOU INCOMPLETA. TENTE NOVAMENTE." },
      { status: 400 },
    );
  }

  await bucket.put(partKey(sessionId, partNumber), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return Response.json({ partNumber });
}

async function readTransportParts(
  bucket: R2Bucket,
  sessionId: string,
  firstPart: number,
  lastPart: number,
) {
  const parts: ArrayBuffer[] = [];
  for (let partNumber = firstPart; partNumber <= lastPart; partNumber += 1) {
    const object = await bucket.get(partKey(sessionId, partNumber));
    if (!object) {
      throw new NotionApiError(
        "O ENVIO DO ARQUIVO FICOU INCOMPLETO. TENTE NOVAMENTE.",
        400,
      );
    }
    parts.push(await object.arrayBuffer());
  }
  return parts;
}

async function createNotionUpload(
  metadata: StagedUpload,
  mode: "single_part" | "multi_part",
  numberOfParts?: number,
) {
  const payload: JsonMap = {
    mode,
    filename: metadata.fileName,
  };
  if (metadata.contentType !== "application/octet-stream") {
    payload.content_type = metadata.contentType;
  }
  if (mode === "multi_part") payload.number_of_parts = numberOfParts;

  const upload = asRecord(
    await notionRequest("/file_uploads", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
  const uploadId = textValue(upload.id);
  if (!uploadId) throw new Error("Notion did not return a file upload id");
  return uploadId;
}

async function sendNotionPart(
  uploadId: string,
  metadata: StagedUpload,
  parts: ArrayBuffer[],
  partNumber?: number,
) {
  const blob = new Blob(parts, { type: metadata.contentType });
  const notionForm = new FormData();
  notionForm.append("file", blob, metadata.fileName);
  if (partNumber) notionForm.append("part_number", String(partNumber));
  await notionRequest(`/file_uploads/${encodeURIComponent(uploadId)}/send`, {
    method: "POST",
    body: notionForm,
  });
}

async function completeStagedUpload(payload: JsonMap) {
  const sessionId = textValue(payload.sessionId);
  if (!sessionIdIsValid(sessionId)) {
    return Response.json(
      { error: "O ENVIO DO ARQUIVO EXPIROU. TENTE NOVAMENTE." },
      { status: 400 },
    );
  }

  const bucket = await uploadsBucket();
  try {
    const metadata = await readMetadata(bucket, sessionId);
    let uploadId = "";

    if (metadata.fileSize <= MAX_SINGLE_PART_SIZE) {
      uploadId = await createNotionUpload(metadata, "single_part");
      const parts = await readTransportParts(
        bucket,
        sessionId,
        1,
        metadata.numberOfParts,
      );
      await sendNotionPart(uploadId, metadata, parts);
    } else {
      const numberOfNotionParts = Math.ceil(
        metadata.fileSize / NOTION_CHUNK_SIZE,
      );
      uploadId = await createNotionUpload(
        metadata,
        "multi_part",
        numberOfNotionParts,
      );
      for (
        let notionPartNumber = 1;
        notionPartNumber <= numberOfNotionParts;
        notionPartNumber += 1
      ) {
        const firstTransportPart =
          (notionPartNumber - 1) * TRANSPORT_PARTS_PER_NOTION_PART + 1;
        const lastTransportPart = Math.min(
          notionPartNumber * TRANSPORT_PARTS_PER_NOTION_PART,
          metadata.numberOfParts,
        );
        const parts = await readTransportParts(
          bucket,
          sessionId,
          firstTransportPart,
          lastTransportPart,
        );
        await sendNotionPart(
          uploadId,
          metadata,
          parts,
          notionPartNumber,
        );
      }
      await notionRequest(
        `/file_uploads/${encodeURIComponent(uploadId)}/complete`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
    }

    return Response.json(
      { file: { id: uploadId, name: metadata.fileName } },
      { status: 201 },
    );
  } finally {
    await removeStagedUpload(bucket, sessionId).catch(() => undefined);
  }
}

async function cancelStagedUpload(payload: JsonMap) {
  const sessionId = textValue(payload.sessionId);
  if (sessionIdIsValid(sessionId)) {
    const bucket = await uploadsBucket();
    await removeStagedUpload(bucket, sessionId);
  }
  return new Response(null, { status: 204 });
}

async function uploadLegacySinglePart(candidate: File) {
  const invalidFile = fileValidationResponse(
    candidate.name,
    candidate.type,
    candidate.size,
  );
  if (invalidFile) return invalidFile;
  if (candidate.size > MAX_SINGLE_PART_SIZE) {
    return Response.json(
      {
        error:
          "ATUALIZE A PÁGINA PARA ENVIAR ARQUIVOS MAIORES EM PARTES.",
      },
      { status: 413 },
    );
  }

  const metadata: StagedUpload = {
    fileName: candidate.name,
    contentType: candidate.type || "application/octet-stream",
    fileSize: candidate.size,
    numberOfParts: 1,
    createdAt: new Date().toISOString(),
  };
  const uploadId = await createNotionUpload(metadata, "single_part");
  const notionForm = new FormData();
  notionForm.append("file", candidate, candidate.name);
  await notionRequest(`/file_uploads/${encodeURIComponent(uploadId)}/send`, {
    method: "POST",
    body: notionForm,
  });

  return Response.json(
    { file: { id: uploadId, name: candidate.name } },
    { status: 201 },
  );
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = asRecord(await request.json());
      const action = textValue(payload.action);
      if (action === "create") return await createStagedUpload(payload);
      if (action === "complete") return await completeStagedUpload(payload);
      if (action === "cancel") return await cancelStagedUpload(payload);
      return Response.json(
        { error: "AÇÃO DE UPLOAD INVÁLIDA." },
        { status: 400 },
      );
    }

    if (contentType.includes("application/octet-stream")) {
      return await storeTransportChunk(request);
    }

    const formData = await request.formData();
    const candidate = formData.get("file");
    if (!(candidate instanceof File)) {
      return Response.json({ error: "SELECIONE UM ARQUIVO." }, { status: 400 });
    }
    return await uploadLegacySinglePart(candidate);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
