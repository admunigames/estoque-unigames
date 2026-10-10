import { unauthorizedResponse } from "../../../../../lib/notion";
import { addDays } from "../../../../../lib/finance-status";
import { isUberMerchant, matchUberRides } from "../../../../../lib/uber-recon";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../../shared";
import { assertCardAccess } from "../../shared";
import type { Database } from "../../../card-fees/shared";

// CONCILIAÇÃO UBER (Cartões Corporativos): corridas anotadas (planilha
// importada) × cobranças UBER da fatura deste cartão.
// GET ?month=AAAA-MM → corridas do mês, cobranças UBER do mês (±1 dia) e o par.
// POST { action }:
//  - import { rows: [{ rideDate, amountCents, passenger, reason }], sourceName } — pula a
//    repetida (mesma data, valor e passageiro) e já casa com as cobranças livres;
//  - automatch { month } — casa de novo (ex.: depois de importar a fatura);
//  - link { rideId, entryId } / unlink { rideId } — ajuste à mão;
//  - delete { ids } — exclui corridas.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Ride = { id: string; rideDate: string; amountCents: number; passenger: string; reason: string; cardEntryId: string };
type Charge = { id: string; entryDate: string; merchant: string; amountCents: number; holderName: string };

function monthBounds(month: string) {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

async function loadMonth(database: Database, cardId: string, month: string) {
  const { from, to } = monthBounds(month);
  const [rides, entries] = await Promise.all([
    database
      .prepare(
        `SELECT id, ride_date AS rideDate, amount_cents AS amountCents, passenger, reason, card_entry_id AS cardEntryId
         FROM finance_uber_rides WHERE card_id=?1 AND ride_date >= ?2 AND ride_date <= ?3 ORDER BY ride_date, id`,
      )
      .bind(cardId, from, to)
      .all<Ride>(),
    database
      .prepare(
        `SELECT id, entry_date AS entryDate, merchant, amount_cents AS amountCents, holder_name AS holderName
         FROM finance_card_invoice_entries WHERE card_id=?1 AND entry_date >= ?2 AND entry_date <= ?3 AND LOWER(merchant) LIKE '%uber%'
         ORDER BY entry_date, id`,
      )
      .bind(cardId, addDays(from, -1), addDays(to, 1))
      .all<Charge>(),
  ]);
  return {
    rides: (rides.results ?? []).map((row) => ({ ...row, amountCents: Number(row.amountCents) })),
    charges: (entries.results ?? []).filter((row) => isUberMerchant(row.merchant)).map((row) => ({ ...row, amountCents: Number(row.amountCents) })),
  };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  const { id } = await context.params;
  const access = await assertCardAccess(request, actor, safeText(id, 80));
  if ("error" in access) return access.error;
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  try {
    const { rides, charges } = await loadMonth(access.database, access.card.id, month);
    const usedCharges = new Set(rides.map((ride) => ride.cardEntryId).filter(Boolean));
    const chargeById = new Map(charges.map((charge) => [charge.id, charge]));
    return jsonResponse({
      month,
      rides: rides.map((ride) => ({ ...ride, charge: chargeById.get(ride.cardEntryId) ?? null })),
      // Cobranças UBER da fatura sem corrida anotada.
      freeCharges: charges.filter((charge) => !usedCharges.has(charge.id)),
      totals: {
        ridesCents: rides.reduce((sum, ride) => sum + ride.amountCents, 0),
        chargesCents: charges.reduce((sum, charge) => sum + charge.amountCents, 0),
      },
    });
  } catch (error) {
    console.error("Não foi possível carregar a conciliação Uber.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A CONCILIAÇÃO UBER." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONCILIAR O CARTÃO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const { id } = await context.params;
  const access = await assertCardAccess(request, actor, safeText(id, 80));
  if ("error" in access) return access.error;
  const { database, card } = access;
  const who = actor.displayName || "Administrador";

  // Casa as corridas livres dos meses informados com as cobranças livres.
  const automatch = async (months: string[]) => {
    let matched = 0;
    for (const month of [...new Set(months)]) {
      const { rides, charges } = await loadMonth(database, card.id, month);
      const used = new Set(rides.map((ride) => ride.cardEntryId).filter(Boolean));
      const pairs = matchUberRides(
        rides.filter((ride) => !ride.cardEntryId).map((ride) => ({ id: ride.id, rideDate: ride.rideDate, amountCents: ride.amountCents })),
        charges.filter((charge) => !used.has(charge.id)),
      );
      if (pairs.length) {
        await database.batch(pairs.map((pair) => database.prepare("UPDATE finance_uber_rides SET card_entry_id=?1 WHERE id=?2").bind(pair.chargeId, pair.rideId)));
      }
      matched += pairs.length;
    }
    return matched;
  };

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 12);
    if (action === "import") {
      const rows = (Array.isArray(body.rows) ? body.rows : []).filter((row): row is JsonMap => Boolean(row) && typeof row === "object");
      if (!rows.length) return jsonResponse({ error: "A PLANILHA NÃO TEM CORRIDAS." }, 400);
      if (rows.length > 3000) return jsonResponse({ error: "PLANILHA GRANDE DEMAIS (MÁX. 3000 CORRIDAS)." }, 400);
      const sourceName = safeText(body.sourceName, 200);
      const existing = await database
        .prepare("SELECT ride_date AS rideDate, amount_cents AS amountCents, passenger FROM finance_uber_rides WHERE card_id=?1")
        .bind(card.id)
        .all<{ rideDate: string; amountCents: number; passenger: string }>();
      const keys = new Set((existing.results ?? []).map((row) => `${row.rideDate}|${Number(row.amountCents)}|${row.passenger.toUpperCase()}`));
      const statements: ReturnType<Database["prepare"]>[] = [];
      const skipped: Array<{ line: number; reason: string }> = [];
      const months: string[] = [];
      rows.forEach((row, index) => {
        const rideDate = safeText(row.rideDate, 10);
        const amountCents = Number(row.amountCents);
        const passenger = safeText(row.passenger, 120);
        if (!DATE_RE.test(rideDate)) return void skipped.push({ line: index + 1, reason: "DATA INVÁLIDA" });
        if (!Number.isInteger(amountCents) || amountCents <= 0) return void skipped.push({ line: index + 1, reason: "VALOR INVÁLIDO" });
        const key = `${rideDate}|${amountCents}|${passenger.toUpperCase()}`;
        if (keys.has(key)) return void skipped.push({ line: index + 1, reason: "JÁ IMPORTADA" });
        keys.add(key);
        months.push(rideDate.slice(0, 7));
        statements.push(
          database
            .prepare(
              `INSERT INTO finance_uber_rides (id, card_id, company_id, ride_date, amount_cents, passenger, reason, source_name, created_by, created_by_name)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
            )
            .bind(crypto.randomUUID(), card.id, card.companyId, rideDate, amountCents, passenger, safeText(row.reason, 300), sourceName, actor.id, who),
        );
      });
      if (statements.length) await database.batch(statements);
      const matched = await automatch(months);
      return jsonResponse({ inserted: statements.length, matched, skipped }, statements.length ? 201 : 200);
    }
    if (action === "automatch") {
      const month = safeText(body.month, 7);
      if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
      return jsonResponse({ matched: await automatch([month]) });
    }
    const rideOf = async (rideId: string) =>
      database.prepare("SELECT id, card_entry_id AS cardEntryId FROM finance_uber_rides WHERE id=?1 AND card_id=?2").bind(rideId, card.id).first<{ id: string; cardEntryId: string }>();
    if (action === "link") {
      const ride = await rideOf(safeText(body.rideId, 80));
      if (!ride) return jsonResponse({ error: "CORRIDA NÃO ENCONTRADA." }, 404);
      const entryId = safeText(body.entryId, 80);
      const entry = await database
        .prepare("SELECT id, merchant FROM finance_card_invoice_entries WHERE id=?1 AND card_id=?2")
        .bind(entryId, card.id)
        .first<{ id: string; merchant: string }>();
      if (!entry) return jsonResponse({ error: "COBRANÇA NÃO ENCONTRADA NA FATURA DESTE CARTÃO." }, 404);
      const taken = await database.prepare("SELECT id FROM finance_uber_rides WHERE card_entry_id=?1 AND id<>?2").bind(entryId, ride.id).first();
      if (taken) return jsonResponse({ error: "ESSA COBRANÇA JÁ ESTÁ BATIDA COM OUTRA CORRIDA." }, 409);
      await database.prepare("UPDATE finance_uber_rides SET card_entry_id=?1 WHERE id=?2").bind(entryId, ride.id).run();
      return jsonResponse({ applied: 1, skipped: [] });
    }
    if (action === "unlink") {
      const ride = await rideOf(safeText(body.rideId, 80));
      if (!ride) return jsonResponse({ error: "CORRIDA NÃO ENCONTRADA." }, 404);
      await database.prepare("UPDATE finance_uber_rides SET card_entry_id='' WHERE id=?1").bind(ride.id).run();
      return jsonResponse({ applied: 1, skipped: [] });
    }
    if (action === "delete") {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 80)).filter(Boolean))];
      if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA CORRIDA." }, 400);
      const found = await database
        .prepare(`SELECT id FROM finance_uber_rides WHERE card_id=?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})`)
        .bind(card.id, ...ids)
        .all<{ id: string }>();
      if ((found.results ?? []).length !== ids.length) return jsonResponse({ error: "ALGUMA CORRIDA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
      await database.batch(ids.map((rideId) => database.prepare("DELETE FROM finance_uber_rides WHERE id=?1").bind(rideId)));
      return jsonResponse({ applied: ids.length, skipped: [] });
    }
    return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível salvar a conciliação Uber.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A CONCILIAÇÃO UBER." }, 500);
  }
}
