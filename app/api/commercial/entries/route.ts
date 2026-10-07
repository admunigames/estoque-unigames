import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { ENTRY_KINDS, MONTH_PATTERN, isEntryKind } from "../../../lib/commercial";
import {
  actorName,
  canManageCommercialCredit,
  commercialScope,
  employeeInScope,
  identity,
  jsonResponse,
  nonNegativeInt,
  safeText,
  sameOrigin,
  syncHrCommissions,
  type JsonMap,
} from "../shared";

// Aba Crediários (comercial:credit): vendas lançadas à mão por tabela —
// PAYJOY, CREFAZ, PARCELEX, ODRES (somam no CREDIÁRIO do vendedor) e VENDA
// P.A, VENDA UNIGAMES (% própria). Só ID DA VENDA, VENDEDOR e VALOR. O
// vendedor precisa estar na aba Vendedores do mês (é lá que a comissão
// aparece). Escopo de loja de sempre: gestor com loja só vê/lança a própria.
// NÃO se mistura com Financeiro > Crediários (finance_credit_sales).
//   GET    ?month&kind → lançamentos da tabela no mês + total
//   POST   {month, kind, saleRef, employeeId, amountCents}
//   DELETE ?id

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManageCommercialCredit(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR CREDIÁRIOS." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) {
    return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  }
  const scope = commercialScope(actor);
  if (!scope) return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  return { actor, scope };
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { scope } = checked;
  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const kind = url.searchParams.get("kind");
  if (!MONTH_PATTERN.test(month) || !isEntryKind(kind)) return jsonResponse({ error: "MÊS OU TABELA INVÁLIDA." }, 400);
  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, sale_ref AS saleRef, employee_id AS employeeId, employee_name AS employeeName,
                company_id AS companyId, amount_cents AS amountCents, created_by_name AS createdByName,
                created_at AS createdAt
         FROM commercial_credit_entries WHERE month=?1 AND kind=?2 ORDER BY created_at DESC`,
      )
      .bind(month, kind)
      .all<{ companyId: string; amountCents: number; employeeName: string }>();
    const items = (result.results ?? [])
      .filter((item) => scope.allStores || item.companyId === scope.companyId)
      .map((item) => ({ ...item, employeeName: String(item.employeeName || "").toLocaleUpperCase("pt-BR") }));
    return jsonResponse({
      month,
      kind,
      label: ENTRY_KINDS[kind].label,
      items,
      totalCents: items.reduce((sum, item) => sum + (Number(item.amountCents) || 0), 0),
    });
  } catch (error) {
    console.error("Não foi possível carregar os lançamentos de crediário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS LANÇAMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const month = safeText(body.month, 7);
    const kind = body.kind;
    const saleRef = safeText(body.saleRef, 60);
    const amountCents = nonNegativeInt(body.amountCents, 100_000_000);
    if (!MONTH_PATTERN.test(month) || !isEntryKind(kind)) return jsonResponse({ error: "MÊS OU TABELA INVÁLIDA." }, 400);
    if (!saleRef) return jsonResponse({ error: "INFORME O ID DA VENDA." }, 400);
    if (!amountCents) return jsonResponse({ error: "INFORME O VALOR DA VENDA." }, 400);
    const database = await getD1();
    const employee = await employeeInScope(database, scope, safeText(body.employeeId, 80));
    if (!employee) return jsonResponse({ error: "VENDEDOR NÃO ENCONTRADO." }, 404);
    const inMonth = await database
      .prepare("SELECT id FROM commercial_monthly WHERE employee_id=?1 AND month=?2")
      .bind(employee.id, month)
      .first();
    if (!inMonth) return jsonResponse({ error: "ADICIONE O VENDEDOR NA ABA VENDEDORES DESTE MÊS ANTES." }, 400);
    const duplicate = await database
      .prepare("SELECT month FROM commercial_credit_entries WHERE kind=?1 AND sale_ref=?2")
      .bind(kind, saleRef)
      .first<{ month: string }>();
    if (duplicate) {
      const [year, monthNumber] = duplicate.month.split("-");
      return jsonResponse({ error: `A VENDA ${saleRef} JÁ FOI LANÇADA EM ${ENTRY_KINDS[kind].label} (${monthNumber}/${year}).` }, 409);
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO commercial_credit_entries
          (id, month, kind, sale_ref, employee_id, employee_name, company_id, amount_cents,
           created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        id, month, kind, saleRef, employee.id, employee.fullName, employee.companyId, amountCents,
        actor.id, actorName(actor), new Date().toISOString(),
      )
      .run();
    await syncHrCommissions(database, month, actor);
    return jsonResponse({ id }, 201);
  } catch (error) {
    console.error("Não foi possível lançar a venda.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LANÇAR A VENDA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { actor, scope } = checked;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  try {
    const database = await getD1();
    const entry = await database
      .prepare("SELECT company_id AS companyId, month FROM commercial_credit_entries WHERE id=?1")
      .bind(id)
      .first<{ companyId: string; month: string }>();
    if (!entry || (!scope.allStores && entry.companyId !== scope.companyId)) {
      return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
    }
    await database.prepare("DELETE FROM commercial_credit_entries WHERE id=?1").bind(id).run();
    await syncHrCommissions(database, entry.month, actor);
    return jsonResponse({ id });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO." }, 500);
  }
}
