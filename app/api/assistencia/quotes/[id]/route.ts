import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { isUniqueViolation, parseQuote, parseSavedPayments } from "../../../../lib/assistencia";
import {
  buildPayments,
  canManage,
  companyName,
  FORBIDDEN,
  identity,
  itemStatements,
  jsonResponse,
  loadQuote,
  loadQuoteDetail,
  NOT_FOUND,
  osConflictMessage,
  osTaken,
  routeParam,
  sameOrigin,
  type JsonMap,
} from "../../shared";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  try {
    const id = routeParam((await context.params).id);
    const database = await getD1();
    const row = await loadQuote(database, id);
    if (!row) return jsonResponse({ error: NOT_FOUND }, 404);
    return jsonResponse(await loadQuoteDetail(database, row));
  } catch (error) {
    console.error("Não foi possível carregar o orçamento da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O ORÇAMENTO." }, 500);
  }
}

// Edição: substitui o cabeçalho e TODAS as linhas numa transação só (batch).
export async function PATCH(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  let osNumber = "";
  try {
    const id = routeParam((await context.params).id);
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const row = await loadQuote(database, id);
    if (!row) return jsonResponse({ error: NOT_FOUND }, 404);
    const parsed = parseQuote(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const quote = parsed.quote;
    osNumber = quote.osNumber;

    // Loja que saiu do cadastro continua valendo no orçamento antigo.
    const resolvedCompanyName =
      quote.companyId === row.companyId
        ? (await companyName(database, quote.companyId)) || row.companyName
        : await companyName(database, quote.companyId);
    if (!resolvedCompanyName) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    if (await osTaken(database, quote.osNumber, id)) {
      return jsonResponse({ error: osConflictMessage(quote.osNumber) }, 409);
    }
    const built = await buildPayments(database, quote.creditOptionId, parseSavedPayments(row.payments));
    if ("error" in built) return jsonResponse({ error: built.error }, 400);

    const at = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `UPDATE assist_quotes
           SET os_number=?1, company_id=?2, company_name=?3, entry_date=?4, client_name=?5, client_cpf=?6,
               client_phone=?7, client_address=?8, observations=?9, extra_notes=?10, total_cents=?11,
               updated_by=?12, updated_by_name=?13, updated_at=?14, payments=?16
           WHERE id=?15`,
        )
        .bind(
          quote.osNumber,
          quote.companyId,
          resolvedCompanyName,
          quote.entryDate,
          quote.clientName,
          quote.clientCpf,
          quote.clientPhone,
          quote.clientAddress,
          JSON.stringify(quote.observations),
          quote.extraNotes,
          quote.totalCents,
          actor.id,
          actor.displayName,
          at,
          id,
          JSON.stringify(built.payments),
        ),
      database.prepare("DELETE FROM assist_quote_items WHERE quote_id=?1").bind(id),
      ...itemStatements(database, id, quote),
    ]);
    return jsonResponse({ updated: true, id, totalCents: quote.totalCents });
  } catch (error) {
    if (osNumber && isUniqueViolation(error)) {
      return jsonResponse({ error: osConflictMessage(osNumber) }, 409);
    }
    console.error("Não foi possível editar o orçamento da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O ORÇAMENTO." }, 500);
  }
}

export async function DELETE(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const id = routeParam((await context.params).id);
    const database = await getD1();
    const row = await loadQuote(database, id);
    if (!row) return jsonResponse({ error: NOT_FOUND }, 404);
    await database.batch([
      database.prepare("DELETE FROM assist_quote_items WHERE quote_id=?1").bind(id),
      database.prepare("DELETE FROM assist_quotes WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o orçamento da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ORÇAMENTO." }, 500);
  }
}
