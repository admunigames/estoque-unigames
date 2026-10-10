import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { isDateOnly, recifeDayStartIso, recifeNextDayStartIso } from "../../lib/divergences";

// Cadastros > Auditoria (audit:view): consulta do registro central gravado
// pelo Worker (worker/index.ts → writeAuditLog). Só leitura.
//   GET ?module&user&from&to&q&offset → { rows, modules, hasMore }

const PAGE_SIZE = 100;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

function canView(request: Request) {
  if (request.headers.get("x-unigames-role") === "admin") return true;
  return (request.headers.get("x-unigames-permissions") || "").split(",").map((p) => p.trim()).includes("audit:view");
}

const text = (value: string | null, max: number) => (value || "").trim().slice(0, max);

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canView(request)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER A AUDITORIA." }, 403);
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, ...params: unknown[]) => {
    // Cada filtro só entra quando foi informado (sem "?N = ''" no SQL).
    filters.push(clause.replace(/\?(\d)/g, (_, n) => `?${values.length + Number(n)}`));
    values.push(...params);
  };
  const moduleName = text(url.searchParams.get("module"), 80);
  const user = text(url.searchParams.get("user"), 80).toLowerCase();
  const from = text(url.searchParams.get("from"), 10);
  const to = text(url.searchParams.get("to"), 10);
  const q = text(url.searchParams.get("q"), 120).toLowerCase();
  if (moduleName) add("module = ?1", moduleName);
  if (user) add("lower(user_name) LIKE ?1", `%${user}%`);
  if (isDateOnly(from)) add("at >= ?1", recifeDayStartIso(from));
  if (isDateOnly(to)) add("at < ?1", recifeNextDayStartIso(to));
  if (q) add("(lower(record_id) = ?1 OR lower(summary) LIKE ?2 OR lower(path) LIKE ?2)", q, `%${q}%`);
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
  try {
    const database = await getD1();
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [rows, modules] = await Promise.all([
      database
        .prepare(
          `SELECT id, at, user_name AS userName, module, action, record_id AS recordId, summary, path, method
           FROM audit_log ${where} ORDER BY at DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`,
        )
        .bind(...values)
        .all<Record<string, unknown>>(),
      database.prepare("SELECT DISTINCT module FROM audit_log ORDER BY module").all<{ module: string }>(),
    ]);
    const list = rows.results ?? [];
    return jsonResponse({
      rows: list.slice(0, PAGE_SIZE),
      hasMore: list.length > PAGE_SIZE,
      modules: (modules.results ?? []).map((row) => row.module).filter(Boolean),
    });
  } catch (error) {
    console.error("Não foi possível carregar a auditoria.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A AUDITORIA." }, 500);
  }
}
