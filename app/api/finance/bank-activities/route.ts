import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// ATIVIDADES FINANCEIRAS da Conciliação Bancária (23/10/2026): lista
// cadastrável de ENTRADAS (ex.: ENTRADA DE VENDA, DEPÓSITO) e SAÍDAS, usada
// para marcar cada lançamento do extrato. Excluir uma atividade já usada só a
// desativa (some das opções, o histórico continua).

const KINDS = ["entrada", "saida"] as const;
type Kind = (typeof KINDS)[number];

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManageFinance(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  try {
    const database = await getD1();
    const rows = await database
      .prepare("SELECT id, kind, name, position, active FROM finance_bank_activities ORDER BY kind, position, name")
      .all();
    return jsonResponse({ activities: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as atividades financeiras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS ATIVIDADES FINANCEIRAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR ATIVIDADES." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const kind = safeText(body.kind, 10) as Kind;
    const name = safeText(body.name, 120);
    if (!KINDS.includes(kind)) return jsonResponse({ error: "ESCOLHA SE É ENTRADA OU SAÍDA." }, 400);
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DA ATIVIDADE." }, 400);
    const database = await getD1();
    const same = await database
      .prepare("SELECT id FROM finance_bank_activities WHERE kind=?1 AND UPPER(name)=UPPER(?2)")
      .bind(kind, name)
      .first<{ id: string }>();
    if (same) {
      await database.prepare("UPDATE finance_bank_activities SET active=1 WHERE id=?1").bind(same.id).run();
      return jsonResponse({ created: false, id: same.id });
    }
    const last = await database
      .prepare("SELECT COALESCE(MAX(position), 0) AS position FROM finance_bank_activities WHERE kind=?1")
      .bind(kind)
      .first<{ position: number }>();
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_bank_activities (id, kind, name, position, active, created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, CURRENT_TIMESTAMP)`,
      )
      .bind(id, kind, name, Number(last?.position ?? 0) + 1, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a atividade financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A ATIVIDADE." }, 500);
  }
}

/** PATCH ?id { name } — renomeia. */
export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR ATIVIDADES." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const id = safeText(new URL(request.url).searchParams.get("id"), 80);
    const name = safeText(((await request.json()) as JsonMap).name, 120);
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DA ATIVIDADE." }, 400);
    const database = await getD1();
    const found = await database.prepare("SELECT id FROM finance_bank_activities WHERE id=?1").bind(id).first<{ id: string }>();
    if (!found) return jsonResponse({ error: "ATIVIDADE NÃO ENCONTRADA." }, 404);
    await database.prepare("UPDATE finance_bank_activities SET name=?1 WHERE id=?2").bind(name, id).run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível editar a atividade financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A ATIVIDADE." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR ATIVIDADES." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const id = safeText(new URL(request.url).searchParams.get("id"), 80);
    const database = await getD1();
    const used = await database
      .prepare("SELECT COUNT(*) AS n FROM finance_bank_statement_entries WHERE activity_id=?1")
      .bind(id)
      .first<{ n: number }>();
    if (Number(used?.n ?? 0) > 0) {
      await database.prepare("UPDATE finance_bank_activities SET active=0 WHERE id=?1").bind(id).run();
      return jsonResponse({ deactivated: true });
    }
    await database.prepare("DELETE FROM finance_bank_activities WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a atividade financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A ATIVIDADE." }, 500);
  }
}
