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

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const formData = await request.formData();
    const candidate = formData.get("file");
    if (!(candidate instanceof File)) {
      return Response.json({ error: "SELECIONE UM ARQUIVO." }, { status: 400 });
    }
    if (candidate.size <= 0 || candidate.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: "O ARQUIVO DEVE TER NO MÁXIMO 20 MB." },
        { status: 400 },
      );
    }
    if (candidate.type && !ALLOWED_TYPES.has(candidate.type)) {
      return Response.json(
        { error: "FORMATO DE ARQUIVO NÃO SUPORTADO." },
        { status: 400 },
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
    const uploadId = typeof upload.id === "string" ? upload.id : "";
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
  } catch (error) {
    return apiErrorResponse(error);
  }
}
