import { getD1 } from "../../../../db";
import { hasCompany } from "../../../lib/access-scope";
import { jsonResponse, safeText, type JsonMap } from "../shared";
import { creditScope, inScope, loadProviders, type CreditScope } from "../credit-sales/shared";

// Financeiras parceiras dos Crediários (Financeiro 7/9). company_id '' = todas
// as lojas. GET lista (com nº de crediários); POST cria; PUT edita; DELETE
// ?id= só exclui financeira sem crediário (com crediário: inativar).

async function save(request: Request, editing: boolean) {
  const scope = creditScope(request, true);
  if (scope instanceof Response) return scope;
  try {
    const body = (await request.json()) as JsonMap;
    const id = editing ? safeText(body.id, 80) : "";
    const name = safeText(body.name, 120).toUpperCase();
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DA FINANCEIRA." }, 400);
    const feeBps = Math.round(Number(body.defaultFeeBps ?? 0));
    if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10000) return jsonResponse({ error: "TAXA PADRÃO INVÁLIDA." }, 400);
    const status = safeText(body.status, 20) === "inactive" ? "inactive" : "active";
    const bankKeyword = safeText(body.bankKeyword, 60);
    const notes = safeText(body.notes, 500);
    // Login de loja só cadastra na própria loja.
    let companyId = scope.allStores ? safeText(body.companyId, 80) : scope.companyId;
    if (companyId && !hasCompany(companyId)) companyId = "";

    const database = await getD1();
    const who = scope.actor.displayName || "Administrador";
    if (editing) {
      const existing = await database
        .prepare("SELECT company_id AS companyId FROM finance_credit_providers WHERE id=?1")
        .bind(id)
        .first<{ companyId: string }>();
      if (!existing) return jsonResponse({ error: "FINANCEIRA NÃO ENCONTRADA." }, 404);
      if (!editable(scope, existing.companyId)) return jsonResponse({ error: "VOCÊ NÃO PODE EDITAR ESTA FINANCEIRA." }, 403);
      companyId = existing.companyId;
    }
    const duplicate = await database
      .prepare("SELECT id FROM finance_credit_providers WHERE lower(name)=lower(?1) AND company_id=?2 AND id<>?3")
      .bind(name, companyId, id)
      .first<{ id: string }>();
    if (duplicate) return jsonResponse({ error: "JÁ EXISTE UMA FINANCEIRA COM ESSE NOME." }, 409);

    if (editing) {
      await database.batch([
        database
          .prepare(
            `UPDATE finance_credit_providers SET name=?1, default_fee_bps=?2, bank_keyword=?3, status=?4, notes=?5,
               updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP WHERE id=?8`,
          )
          .bind(name, feeBps, bankKeyword, status, notes, scope.actor.id, who, id),
        // O nome é snapshot no crediário: acompanha o cadastro.
        database.prepare("UPDATE finance_credit_sales SET provider_name=?1 WHERE provider_id=?2").bind(name, id),
      ]);
      return jsonResponse({ updated: true, id });
    }
    const newId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_credit_providers
           (id, name, company_id, default_fee_bps, bank_keyword, status, notes, created_by, created_by_name, updated_by, updated_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?8, ?9)`,
      )
      .bind(newId, name, companyId, feeBps, bankKeyword, status, notes, scope.actor.id, who)
      .run();
    return jsonResponse({ created: true, id: newId }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A FINANCEIRA." }, 500);
  }
}

/** Financeira de todas as lojas: só quem vê todas as lojas edita. */
function editable(scope: CreditScope, companyId: string) {
  return companyId ? inScope(scope, companyId) : scope.allStores;
}

export async function GET(request: Request) {
  const scope = creditScope(request, false);
  if (scope instanceof Response) return scope;
  try {
    const database = await getD1();
    const [providers, counts] = await Promise.all([
      loadProviders(database, scope),
      database
        .prepare("SELECT provider_id AS providerId, COUNT(*) AS total FROM finance_credit_sales GROUP BY provider_id")
        .all<{ providerId: string; total: number }>(),
    ]);
    const total = new Map((counts.results ?? []).map((row) => [row.providerId, Number(row.total)]));
    return jsonResponse({ providers: providers.map((row) => ({ ...row, creditSales: total.get(row.id) ?? 0 })) });
  } catch (error) {
    console.error("Não foi possível carregar as financeiras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS FINANCEIRAS." }, 500);
  }
}

export function POST(request: Request) {
  return save(request, false);
}

export function PUT(request: Request) {
  return save(request, true);
}

export async function DELETE(request: Request) {
  const scope = creditScope(request, true);
  if (scope instanceof Response) return scope;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT company_id AS companyId FROM finance_credit_providers WHERE id=?1")
      .bind(id)
      .first<{ companyId: string }>();
    if (!existing) return jsonResponse({ error: "FINANCEIRA NÃO ENCONTRADA." }, 404);
    if (!editable(scope, existing.companyId)) return jsonResponse({ error: "VOCÊ NÃO PODE EXCLUIR ESTA FINANCEIRA." }, 403);
    const used = await database.prepare("SELECT id FROM finance_credit_sales WHERE provider_id=?1 LIMIT 1").bind(id).first();
    if (used) return jsonResponse({ error: "FINANCEIRA COM CREDIÁRIOS NÃO PODE SER EXCLUÍDA. INATIVE-A." }, 409);
    await database.prepare("DELETE FROM finance_credit_providers WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir a financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A FINANCEIRA." }, 500);
  }
}
