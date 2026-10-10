import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { insertDeclarationStatement } from "../shared";

// Declaração de Vendas — PLANEJAR O ANO: o valor A DECLARAR de cada loja em
// cada mês do ano. Depois, mês a mês, o real declarado entra na mesma linha
// (edição ou cadastro em lote); enquanto declared_cents = 0 o mês fica
// "AGUARDANDO DECLARAÇÃO".
// GET ?year=AAAA → { rows: [{ id, companyId, competenceMonth, plannedCents, declaredCents }] }
// POST { year, rows: [{ companyId, companyName, competenceMonth, plannedCents }] } — numa transação:
//   mês existente → atualiza só o A DECLARAR; mês novo → cria a linha só com ele.

const YEAR_PATTERN = /^\d{4}$/;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  const year = safeText(new URL(request.url).searchParams.get("year"), 4);
  if (!YEAR_PATTERN.test(year)) return jsonResponse({ error: "INFORME O ANO (AAAA)." }, 400);
  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT id, company_id AS companyId, competence_month AS competenceMonth, planned_cents AS plannedCents,
                declared_cents AS declaredCents
         FROM finance_mall_declarations WHERE competence_month >= ?1 AND competence_month <= ?2`,
      )
      .bind(`${year}-01`, `${year}-12`)
      .all();
    return jsonResponse({ year, rows: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o planejamento da declaração.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O PLANEJAMENTO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DECLARAÇÕES." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const year = safeText(body.year, 4);
    if (!YEAR_PATTERN.test(year)) return jsonResponse({ error: "INFORME O ANO (AAAA)." }, 400);
    const rows = (Array.isArray(body.rows) ? body.rows : []).filter((row): row is JsonMap => Boolean(row) && typeof row === "object");
    if (!rows.length) return jsonResponse({ error: "PREENCHA AO MENOS UM MÊS." }, 400);
    if (rows.length > 12 * 60) return jsonResponse({ error: "PLANEJAMENTO GRANDE DEMAIS." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, company_id AS companyId, competence_month AS competenceMonth FROM finance_mall_declarations WHERE competence_month >= ?1 AND competence_month <= ?2")
      .bind(`${year}-01`, `${year}-12`)
      .all<{ id: string; companyId: string; competenceMonth: string }>();
    const idOf = new Map((existing.results ?? []).map((row) => [`${row.companyId}|${row.competenceMonth}`, row.id]));
    const who = actor.displayName || "Administrador";
    const statements = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const companyId = safeText(row.companyId, 80);
      const competenceMonth = safeText(row.competenceMonth, 7);
      const plannedCents = Number(row.plannedCents);
      if (!companyId) return jsonResponse({ error: "LOJA NÃO INFORMADA NO PLANEJAMENTO." }, 400);
      if (!competenceMonth.startsWith(`${year}-`) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competenceMonth)) {
        return jsonResponse({ error: `MÊS FORA DO ANO ${year}.` }, 400);
      }
      if (!Number.isInteger(plannedCents) || plannedCents < 0) return jsonResponse({ error: "INFORME VALORES VÁLIDOS EM CENTAVOS." }, 400);
      const key = `${companyId}|${competenceMonth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = idOf.get(key);
      if (id) {
        statements.push(
          database
            .prepare("UPDATE finance_mall_declarations SET planned_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4")
            .bind(plannedCents, actor.id, who, id),
        );
      } else if (plannedCents > 0) {
        statements.push(
          insertDeclarationStatement(database, {
            id: crypto.randomUUID(), companyId, companyName: safeText(row.companyName, 160), competenceMonth,
            realRevenueCents: 0, declaredCents: 0, contractPercentBps: 0, minimumRentCents: 0,
            percentageRentPaid: 0, notes: "", actorId: actor.id, who, plannedCents,
          }),
        );
      }
    }
    if (statements.length) await database.batch(statements);
    return jsonResponse({ saved: statements.length });
  } catch (error) {
    console.error("Não foi possível salvar o planejamento da declaração.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O PLANEJAMENTO. NADA FOI GRAVADO." }, 500);
  }
}
