import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import {
  DATE_PATTERN,
  actorName,
  canManagePayroll,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Cadastro de feriados (nacionais ou por loja). Descontados dos dias úteis
// do mês no cálculo de benefícios pagos por dia trabalhado.

const HOLIDAY_SCOPES = ["nacional", "local"] as const;

type HolidayRow = {
  id: string;
  date: string;
  name: string;
  scope: string;
  companyId: string;
  companyName: string;
  createdByName: string;
  createdAt: string;
  updatedByName: string;
  updatedAt: string;
};

const HOLIDAY_COLUMNS = `id, date, name, scope, company_id AS companyId, company_name AS companyName,
  created_by_name AS createdByName, created_at AS createdAt,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR OS FERIADOS." }, 403);
  }

  const url = new URL(request.url);
  const year = safeText(url.searchParams.get("year"), 4);

  try {
    const database = await getD1();
    const where = /^\d{4}$/.test(year) ? "WHERE substr(date, 1, 4) = ?1" : "";
    const result = await database
      .prepare(`SELECT ${HOLIDAY_COLUMNS} FROM hr_holidays ${where} ORDER BY date ASC`)
      .bind(...(where ? [year] : []))
      .all<HolidayRow>();
    return jsonResponse({ holidays: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os feriados.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS FERIADOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR FERIADOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const date = safeText(body.date, 10);
    const name = safeText(body.name, 120);
    const scope = safeText(body.scope, 20) || "nacional";
    let companyId = safeText(body.companyId, 80);

    if (!DATE_PATTERN.test(date)) {
      return jsonResponse({ error: "INFORME UMA DATA VÁLIDA (AAAA-MM-DD)." }, 400);
    }
    if (!(HOLIDAY_SCOPES as readonly string[]).includes(scope)) {
      return jsonResponse({ error: "ABRANGÊNCIA INVÁLIDA." }, 400);
    }

    const database = await getD1();
    let companyName = "";
    if (scope === "local") {
      if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA DO FERIADO LOCAL." }, 400);
      const companies = await loadCompanyList(database);
      const company = companies.find((item) => item.id === companyId);
      if (!company) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
      companyName = company.name;
    } else {
      companyId = "";
    }

    const duplicate = await database
      .prepare("SELECT id FROM hr_holidays WHERE date=?1 AND company_id=?2 AND id<>?3 LIMIT 1")
      .bind(date, companyId, editId || "")
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse({ error: "JÁ EXISTE UM FERIADO CADASTRADO NESSA DATA PARA ESSA ABRANGÊNCIA." }, 409);
    }

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_holidays WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "FERIADO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_holidays
           SET date=?1, name=?2, scope=?3, company_id=?4, company_name=?5,
               updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP
           WHERE id=?8`,
        )
        .bind(date, name, scope, companyId, companyName, actor.id, actorName(actor), editId)
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_holidays
          (id, date, name, scope, company_id, company_name, created_by, created_by_name,
           created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)`,
      )
      .bind(id, date, name, scope, companyId, companyName, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o feriado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O FERIADO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR FERIADOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "FERIADO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    await database.prepare("DELETE FROM hr_holidays WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o feriado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O FERIADO." }, 500);
  }
}
