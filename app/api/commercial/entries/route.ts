import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  COMMERCIAL_CHANNELS,
  COMMERCIAL_KINDS,
  DATE_PATTERN,
  MONTH_PATTERN,
} from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  actorName,
  canManageCommercial,
  commercialScope,
  identity,
  jsonResponse,
  loadSellerForWrite,
  safeText,
  sameOrigin,
  uuidIsValid,
  type JsonMap,
} from "../shared";

// Lançamentos ACUMULADOS do realizado (ver realizedFromEntries em
// app/lib/commercial.ts): cada lançamento informa o total do mês até a
// data, por canal (Loja/Online) e tipo (Faturamento/Itens/Garantia). O
// mais recente vale; os anteriores ficam como histórico.

const MAX_VALUE = 2_000_000_000;

type EntryHistoryRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  channel: string;
  kind: string;
  value: number;
  entryDate: string;
  createdByName: string;
  createdAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER OS LANÇAMENTOS." }, 403);
  }
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const employeeId = safeText(url.searchParams.get("employeeId"), 80);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const conditions = ["month=?1"];
    const bindings: string[] = [month];
    if (employeeId) {
      bindings.push(employeeId);
      conditions.push(`employee_id=?${bindings.length}`);
    }
    if (!scope.allStores) {
      bindings.push(scope.companyId);
      conditions.push(`company_id=?${bindings.length}`);
    }
    const result = await database
      .prepare(
        `SELECT id, employee_id AS employeeId, employee_name AS employeeName, company_id AS companyId,
                company_name AS companyName, channel, kind, value, entry_date AS entryDate,
                created_by_name AS createdByName, created_at AS createdAt
         FROM commercial_entries WHERE ${conditions.join(" AND ")}
         ORDER BY entry_date DESC, created_at DESC
         LIMIT 500`,
      )
      .bind(...bindings)
      .all<EntryHistoryRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os lançamentos do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS LANÇAMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O REALIZADO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    const entryDate = safeText(body.entryDate, 10);
    if (!employeeId) return jsonResponse({ error: "SELECIONE O VENDEDOR." }, 400);
    if (!DATE_PATTERN.test(entryDate)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    if (entryDate > todayInTimezone()) {
      return jsonResponse({ error: "A DATA DO LANÇAMENTO NÃO PODE SER FUTURA." }, 400);
    }

    const values = (body.values && typeof body.values === "object" ? body.values : {}) as JsonMap;
    const rows: { channel: string; kind: string; value: number }[] = [];
    for (const kind of COMMERCIAL_KINDS) {
      const byChannel = (values[kind] && typeof values[kind] === "object" ? values[kind] : {}) as JsonMap;
      for (const channel of COMMERCIAL_CHANNELS) {
        const raw = byChannel[channel];
        if (raw === null || raw === undefined || raw === "") continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE) {
          return jsonResponse({ error: "INFORME VALORES VÁLIDOS (ZERO OU MAIS)." }, 400);
        }
        rows.push({ channel, kind, value: Math.round(value) });
      }
    }
    if (!rows.length) return jsonResponse({ error: "PREENCHA AO MENOS UM VALOR ACUMULADO." }, 400);

    const database = await getD1();
    const seller = await loadSellerForWrite(database, actor, employeeId);
    if ("error" in seller) return jsonResponse({ error: seller.error }, seller.status);

    const month = entryDate.slice(0, 7);
    const statements = rows.map((row) =>
      database
        .prepare(
          `INSERT INTO commercial_entries
            (id, employee_id, employee_name, company_id, company_name, month, channel, kind, value,
             entry_date, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, CURRENT_TIMESTAMP)`,
        )
        .bind(
          crypto.randomUUID(),
          seller.employee.id,
          seller.employee.fullName,
          seller.employee.companyId,
          seller.companyName,
          month,
          row.channel,
          row.kind,
          row.value,
          entryDate,
          actor.id,
          actorName(actor),
        ),
    );
    await database.batch(statements);
    return jsonResponse({ created: rows.length }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o lançamento do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LANÇAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR LANÇAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, company_id AS companyId FROM commercial_entries WHERE id=?1")
      .bind(id)
      .first<{ id: string; companyId: string }>();
    if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
    if (!scope.allStores && existing.companyId !== scope.companyId) {
      return jsonResponse({ error: "VOCÊ SÓ PODE EXCLUIR LANÇAMENTOS DA SUA LOJA." }, 403);
    }
    await database.prepare("DELETE FROM commercial_entries WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO." }, 500);
  }
}
