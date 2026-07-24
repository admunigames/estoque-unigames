import {
  apiErrorResponse,
  notionRequest,
  unauthorizedResponse,
} from "../../../lib/notion";

type JsonMap = Record<string, unknown>;

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : {};
}

const MULTIPART_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_SINGLE_PART_SIZE = 20 * 1024 * 1024;
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

function uploadIdIsValid(value: string) {
  return /^[0-9a-f-]{32,36}$/i.test(value);
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

async function createMultipartUpload(payload: JsonMap) {
  const fileName = textValue(payload.fileName);
  const contentType = textValue(payload.contentType);
  const fileSize = numberValue(payload.fileSize);
  const numberOfParts = numberValue(payload.numberOfParts);
  const invalidFile = fileValidationResponse(fileName, contentType, fileSize);
  if (invalidFile) return invalidFile;

  const expectedParts = Math.max(1, Math.ceil(fileSize / MULTIPART_CHUNK_SIZE));
  if (
    !Number.isInteger(numberOfParts) ||
    numberOfParts !== expectedParts
  ) {
    return Response.json(
      { error: "A DIVISÃO DO ARQUIVO É INVÁLIDA. SELECIONE-O NOVAMENTE." },
      { status: 400 },
    );
  }

  const notionPayload: JsonMap = {
    mode: "multi_part",
    number_of_parts: numberOfParts,
    filename: fileName,
  };
  if (contentType && contentType !== "application/octet-stream") {
    notionPayload.content_type = contentType;
  }

  const upload = asRecord(
    await notionRequest("/file_uploads", {
      method: "POST",
      body: JSON.stringify(notionPayload),
    }),
  );
  const uploadId = textValue(upload.id);
  if (!uploadId) throw new Error("Notion did not return a file upload id");

  return Response.json(
    { upload: { id: uploadId, name: fileName, numberOfParts } },
    { status: 201 },
  );
}

async function completeMultipartUpload(payload: JsonMap) {
  const uploadId = textValue(payload.uploadId);
  const fileName = textValue(payload.fileName);
  if (!uploadIdIsValid(uploadId) || !fileName) {
    return Response.json(
      { error: "O ENVIO DO ARQUIVO EXPIROU. TENTE NOVAMENTE." },
      { status: 400 },
    );
  }

  await notionRequest(
    `/file_uploads/${encodeURIComponent(uploadId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );

  return Response.json(
    { file: { id: uploadId, name: fileName } },
    { status: 201 },
  );
}

async function sendMultipartChunk(formData: FormData) {
  const uploadId = textValue(formData.get("uploadId"));
  const partNumber = numberValue(formData.get("partNumber"));
  const candidate = formData.get("file");
  if (
    !uploadIdIsValid(uploadId) ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    !(candidate instanceof File) ||
    candidate.size <= 0 ||
    candidate.size > MULTIPART_CHUNK_SIZE
  ) {
    return Response.json(
      { error: "UMA PARTE DO ARQUIVO É INVÁLIDA. TENTE NOVAMENTE." },
      { status: 400 },
    );
  }

  const notionForm = new FormData();
  notionForm.append("file", candidate, candidate.name);
  notionForm.append("part_number", String(partNumber));
  await notionRequest(`/file_uploads/${encodeURIComponent(uploadId)}/send`, {
    method: "POST",
    body: notionForm,
  });

  return Response.json({ partNumber });
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

  const upload = asRecord(
    await notionRequest("/file_uploads", {
      method: "POST",
      body: JSON.stringify({
        mode: "single_part",
        filename: candidate.name,
        content_type: candidate.type || "application/octet-stream",
      }),
    }),
  );
  const uploadId = textValue(upload.id);
  if (!uploadId) throw new Error("Notion did not return a file upload id");

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
      if (action === "create") return await createMultipartUpload(payload);
      if (action === "complete") return await completeMultipartUpload(payload);
      return Response.json(
        { error: "AÇÃO DE UPLOAD INVÁLIDA." },
        { status: 400 },
      );
    }

    const formData = await request.formData();
    if (formData.has("uploadId")) return await sendMultipartChunk(formData);
    const candidate = formData.get("file");
    if (!(candidate instanceof File)) {
      return Response.json({ error: "SELECIONE UM ARQUIVO." }, { status: 400 });
    }
    return await uploadLegacySinglePart(candidate);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
