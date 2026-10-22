import type { getD1 } from "../../../db";
import { jsonResponse, type JsonMap } from "./shared";

type Database = Awaited<ReturnType<typeof getD1>>;
export type BatchStatement = [string, unknown[]];
export type BatchRowPlan = { error: string } | { statements: BatchStatement[] };

export const BATCH_MAX_ROWS = 200;

/**
 * Cadastro em LOTE do Financeiro (componente único da tela,
 * openFinanceBatchDialog): valida TODAS as linhas pelo mesmo planejador do
 * cadastro individual e grava numa transação só — tudo ou nada.
 *   corpo: {rows: [...], dryRun: boolean, batchKey: string}
 *   resposta: {ok, created, errors: [{line, error}]} (line começa em 1)
 * dryRun=true só confere (prévia linha a linha). Com qualquer linha com erro
 * nada é gravado (400 fora da prévia).
 */
export async function runBatchCreate(
  database: Database,
  body: JsonMap,
  plan: (row: JsonMap, line: number, batchKey: string) => Promise<BatchRowPlan>,
): Promise<Response> {
  const rows = Array.isArray(body.rows) ? (body.rows as unknown[]).filter((row): row is JsonMap => Boolean(row) && typeof row === "object") : [];
  if (!rows.length) return jsonResponse({ ok: false, created: 0, errors: [], error: "INFORME AO MENOS UMA LINHA." }, 400);
  if (rows.length > BATCH_MAX_ROWS) {
    return jsonResponse({ ok: false, created: 0, errors: [], error: `NO MÁXIMO ${BATCH_MAX_ROWS} LINHAS POR LOTE.` }, 400);
  }
  const dryRun = body.dryRun === true;
  const batchKey = typeof body.batchKey === "string" && body.batchKey.trim() ? body.batchKey.trim().slice(0, 80) : crypto.randomUUID();
  const errors: Array<{ line: number; error: string }> = [];
  const statements: BatchStatement[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = await plan(rows[index], index + 1, batchKey);
    if ("error" in result) errors.push({ line: index + 1, error: result.error });
    else statements.push(...result.statements);
  }
  if (errors.length) {
    return jsonResponse(
      { ok: false, created: 0, errors, error: dryRun ? undefined : `${errors.length} LINHA(S) COM ERRO — NADA FOI GRAVADO.` },
      dryRun ? 200 : 400,
    );
  }
  if (dryRun) return jsonResponse({ ok: true, created: 0, valid: rows.length, errors: [] });
  try {
    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
  } catch (error) {
    console.error("Cadastro em lote recusado pelo banco.", error);
    return jsonResponse(
      { ok: false, created: 0, errors: [], error: "O LOTE FOI RECUSADO (LINHAS REPETIDAS OU CONFLITO COM UM CADASTRO EXISTENTE) — NADA FOI GRAVADO." },
      409,
    );
  }
  return jsonResponse({ ok: true, created: rows.length, errors: [] }, 201);
}
