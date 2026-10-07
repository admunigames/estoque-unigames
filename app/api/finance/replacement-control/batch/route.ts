import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { insertReplacementStatement, parseReplacementEntry } from "../shared";

// CADASTRAR EM LOTE no Controle de Reposição (Financeiro 9/9): { rows[] } com
// os mesmos campos do cadastro individual (mesma validação). Tudo numa
// transação; devolve criadas e puladas (linha + motivo).

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR NO CONTROLE DE REPOSIÇÃO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const rows = (Array.isArray(body.rows) ? body.rows : []).filter((row): row is JsonMap => Boolean(row) && typeof row === "object");
    if (!rows.length) return jsonResponse({ error: "PREENCHA AO MENOS UMA LINHA." }, 400);
    if (rows.length > 300) return jsonResponse({ error: "LOTE GRANDE DEMAIS (MÁX. 300 LINHAS)." }, 400);

    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    const statements: [string, unknown[]][] = [];
    const skipped: Array<{ line: number; description: string; reason: string }> = [];
    rows.forEach((row, index) => {
      const parsed = parseReplacementEntry(row);
      if ("error" in parsed) skipped.push({ line: index + 1, description: safeText(row.product, 200), reason: parsed.error });
      else statements.push(insertReplacementStatement(parsed, who));
    });
    if (statements.length) {
      const database = await getD1();
      await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    }
    return jsonResponse({ created: statements.length, skipped }, statements.length ? 201 : 200);
  } catch (error) {
    console.error("Não foi possível cadastrar os lançamentos em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR EM LOTE. NADA FOI GRAVADO." }, 500);
  }
}
