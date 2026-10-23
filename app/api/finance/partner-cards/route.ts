import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { DATE_PATTERN } from "../../../lib/payables-recurrence";
import { installmentForMonth, netCents } from "../../../lib/partner-cards";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../shared";

// CARTÕES DE CRÉDITO SÓCIO (23/10/2026) — aba nova em Cartões de Crédito.
// Compras feitas no cartão pessoal do sócio que a empresa devolve.
//
// GET    ?month=AAAA-MM → lançamentos (com a parcela do mês), responsáveis e,
//        por responsável, o total do mês + a conta a pagar gerada.
// POST   {id?, responsibleName, description, purchaseDate, amountCents,
//         discountCents, installments, fixed, firstMonth, endMonth, notes}
// DELETE ?id=
// PUT    {responsibleName, month, paymentDate} → o TOTAL DO MÊS do responsável
//        vira (ou atualiza) uma conta em Contas a Pagar com vencimento na data
//        de pagamento. Fora da DRE (dre_target 'none'): é reembolso ao sócio.

type Database = Awaited<ReturnType<typeof getD1>>;
type EntryRow = {
  id: string;
  responsibleName: string;
  description: string;
  purchaseDate: string;
  amountCents: number;
  discountCents: number;
  installments: number;
  fixed: number;
  firstMonth: string;
  endMonth: string;
  notes: string;
};

const ENTRY_COLUMNS = `id, responsible_name AS responsibleName, description, purchase_date AS purchaseDate,
  amount_cents AS amountCents, discount_cents AS discountCents, installments, fixed,
  first_month AS firstMonth, end_month AS endMonth, notes`;

function guard(request: Request, write = false) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403) };
  }
  if (write && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

async function monthTotals(database: Database, month: string) {
  const rows = await database
    .prepare(`SELECT ${ENTRY_COLUMNS} FROM finance_partner_card_entries ORDER BY responsible_name, purchase_date, id`)
    .all<EntryRow>();
  const entries = (rows.results ?? []).map((row) => {
    const entry = { ...row, amountCents: Number(row.amountCents), discountCents: Number(row.discountCents), installments: Number(row.installments), fixed: Number(row.fixed) };
    const part = installmentForMonth(entry, month);
    return { ...entry, netCents: netCents(entry), monthCents: part.cents, installmentNumber: part.number };
  });
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.monthCents > 0) totals.set(entry.responsibleName, (totals.get(entry.responsibleName) ?? 0) + entry.monthCents);
  }
  return { entries, totals };
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  try {
    const database = await getD1();
    const [{ entries, totals }, names, payments] = await Promise.all([
      monthTotals(database, month),
      database.prepare("SELECT DISTINCT responsible_name AS name FROM finance_partner_card_entries ORDER BY responsible_name").all<{ name: string }>(),
      database
        .prepare(
          `SELECT p.responsible_name AS responsibleName, p.payment_date AS paymentDate, p.payable_id AS payableId,
                  a.original_amount_cents AS payableAmountCents, a.paid_amount_cents AS payablePaidCents, a.status AS payableStatus
           FROM finance_partner_card_payments p
           LEFT JOIN accounts_payable a ON a.id = p.payable_id
           WHERE p.month = ?1`,
        )
        .bind(month)
        .all<{ responsibleName: string; paymentDate: string; payableId: string; payableAmountCents: number | null; payablePaidCents: number | null; payableStatus: string | null }>(),
    ]);
    const paymentOf = new Map((payments.results ?? []).map((row) => [row.responsibleName, row]));
    const responsibles = [...new Set([...totals.keys(), ...paymentOf.keys()])].sort((a, b) => a.localeCompare(b, "pt-BR"));
    return jsonResponse({
      month,
      entries: entries.filter((entry) => entry.monthCents > 0),
      // Lançamentos que já acabaram ou ainda não começaram ficam em `others`.
      others: entries.filter((entry) => entry.monthCents <= 0),
      names: (names.results ?? []).map((row) => row.name),
      summary: responsibles.map((name) => {
        const payment = paymentOf.get(name);
        const payableOpen = payment?.payableStatus && payment.payableStatus !== "canceled";
        const totalCents = totals.get(name) ?? 0;
        return {
          responsibleName: name,
          totalCents,
          paymentDate: payment?.paymentDate ?? "",
          payableId: payableOpen ? payment!.payableId : "",
          payableAmountCents: payableOpen ? Number(payment!.payableAmountCents) : null,
          payableStatus: payableOpen ? payment!.payableStatus : "",
          outdated: Boolean(payableOpen) && Number(payment!.payableAmountCents) !== totalCents,
        };
      }),
    });
  } catch (error) {
    console.error("Não foi possível carregar os cartões do sócio.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS CARTÕES DE CRÉDITO SÓCIO." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request, true);
  if (checked.error) return checked.error;
  const actor = checked.actor;
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const responsibleName = safeText(body.responsibleName, 120);
    const description = safeText(body.description, 300);
    const purchaseDate = safeText(body.purchaseDate, 10);
    const amountCents = Number(body.amountCents);
    const discountCents = body.discountCents === undefined || body.discountCents === "" || body.discountCents === null ? 0 : Number(body.discountCents);
    const fixed = body.fixed === true || body.fixed === 1 || body.fixed === "1" ? 1 : 0;
    const installments = fixed ? 1 : Number(body.installments ?? 1);
    const firstMonth = safeText(body.firstMonth, 7);
    const endMonth = fixed ? safeText(body.endMonth, 7) : "";
    const notes = safeText(body.notes, 1000);
    if (!responsibleName) return jsonResponse({ error: "INFORME O RESPONSÁVEL." }, 400);
    if (!description) return jsonResponse({ error: "INFORME O LANÇAMENTO (DESCRIÇÃO)." }, 400);
    if (purchaseDate && !DATE_PATTERN.test(purchaseDate)) return jsonResponse({ error: "DATA DE COMPRA INVÁLIDA." }, 400);
    if (!Number.isInteger(amountCents) || amountCents <= 0) return jsonResponse({ error: "INFORME O VALOR." }, 400);
    if (!Number.isInteger(discountCents) || discountCents < 0 || discountCents > amountCents) {
      return jsonResponse({ error: "O DESCONTO PRECISA SER ENTRE ZERO E O VALOR." }, 400);
    }
    if (!Number.isInteger(installments) || installments < 1 || installments > 60) return jsonResponse({ error: "PARCELAS: DE 1 A 60." }, 400);
    if (!MONTH_PATTERN.test(firstMonth)) return jsonResponse({ error: "INFORME O MÊS DA 1ª PARCELA." }, 400);
    if (endMonth && (!MONTH_PATTERN.test(endMonth) || endMonth < firstMonth)) {
      return jsonResponse({ error: "O MÊS FINAL PRECISA SER DEPOIS DO 1º MÊS." }, 400);
    }
    const database = await getD1();
    const who = actor.displayName || "Administrador";
    if (id) {
      const existing = await database.prepare("SELECT id FROM finance_partner_card_entries WHERE id=?1").bind(id).first();
      if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE finance_partner_card_entries
           SET responsible_name=?1, description=?2, purchase_date=?3, amount_cents=?4, discount_cents=?5, installments=?6,
               fixed=?7, first_month=?8, end_month=?9, notes=?10, updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP
           WHERE id=?13`,
        )
        .bind(responsibleName, description, purchaseDate, amountCents, discountCents, installments, fixed, firstMonth, endMonth, notes, actor.id, who, id)
        .run();
      return jsonResponse({ updated: true, id });
    }
    const newId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_partner_card_entries
          (id, responsible_name, description, purchase_date, amount_cents, discount_cents, installments, fixed,
           first_month, end_month, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP, ?12, ?13, CURRENT_TIMESTAMP)`,
      )
      .bind(newId, responsibleName, description, purchaseDate, amountCents, discountCents, installments, fixed, firstMonth, endMonth, notes, actor.id, who)
      .run();
    return jsonResponse({ created: true, id: newId }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o lançamento do cartão do sócio.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LANÇAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request, true);
  if (checked.error) return checked.error;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM finance_partner_card_entries WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento do cartão do sócio.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO." }, 500);
  }
}

export async function PUT(request: Request) {
  const checked = guard(request, true);
  if (checked.error) return checked.error;
  const actor = checked.actor;
  try {
    const body = (await request.json()) as JsonMap;
    const responsibleName = safeText(body.responsibleName, 120).toLocaleUpperCase("pt-BR");
    const month = safeText(body.month, 7);
    const paymentDate = safeText(body.paymentDate, 10);
    if (!responsibleName) return jsonResponse({ error: "INFORME O RESPONSÁVEL." }, 400);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
    if (!DATE_PATTERN.test(paymentDate)) return jsonResponse({ error: "INFORME A DATA DE PAGAMENTO." }, 400);
    const database = await getD1();
    const { totals } = await monthTotals(database, month);
    const totalCents = totals.get(responsibleName) ?? 0;
    if (totalCents <= 0) return jsonResponse({ error: "ESSE RESPONSÁVEL NÃO TEM VALOR A RECEBER NO MÊS." }, 400);
    const who = actor.displayName || "Administrador";
    const description = `CARTÃO SÓCIO — ${responsibleName} — ${month.slice(5, 7)}/${month.slice(0, 4)}`;

    const payment = await database
      .prepare("SELECT payable_id AS payableId FROM finance_partner_card_payments WHERE responsible_name=?1 AND month=?2")
      .bind(responsibleName, month)
      .first<{ payableId: string }>();
    const payable = payment?.payableId
      ? await database
          .prepare("SELECT id, status, paid_amount_cents AS paidCents, original_amount_cents AS amountCents FROM accounts_payable WHERE id=?1")
          .bind(payment.payableId)
          .first<{ id: string; status: string; paidCents: number; amountCents: number }>()
      : null;

    let payableId = "";
    if (payable && payable.status !== "canceled") {
      if (Number(payable.paidCents) > 0 && Number(payable.amountCents) !== totalCents) {
        return jsonResponse({ error: "A CONTA A PAGAR DESTE MÊS JÁ TEM PAGAMENTO E O TOTAL MUDOU — AJUSTE EM CONTAS A PAGAR." }, 409);
      }
      payableId = payable.id;
      await database
        .prepare(
          `UPDATE accounts_payable SET original_amount_cents=?1, due_date=?2, description=?3,
             updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
           WHERE id=?6`,
        )
        .bind(totalCents, paymentDate, description, actor.id, who, payableId)
        .run();
    } else {
      payableId = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO accounts_payable
            (id, company_id, company_name, description, supplier_id, finance_item_id, original_amount_cents, paid_amount_cents,
             dre_amount_cents, competence_month, due_date, status, notes, idempotency_key, created_by, created_by_name,
             created_at, updated_by, updated_by_name, updated_at, dre_target)
           VALUES (?1, '', '', ?2, '', '', ?3, 0, 0, ?4, ?5, 'open', 'GERADA EM CARTÕES DE CRÉDITO SÓCIO', ?6, ?7, ?8,
                   CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP, 'none')`,
        )
        .bind(payableId, description, totalCents, month, paymentDate, `partner-card:${responsibleName}:${month}:${payableId}`, actor.id, who)
        .run();
    }
    await database
      .prepare(
        `INSERT INTO finance_partner_card_payments (id, responsible_name, month, payment_date, payable_id, total_cents, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
         ON CONFLICT (responsible_name, month) DO UPDATE SET payment_date=excluded.payment_date, payable_id=excluded.payable_id,
           total_cents=excluded.total_cents, updated_by=excluded.updated_by, updated_by_name=excluded.updated_by_name, updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(crypto.randomUUID(), responsibleName, month, paymentDate, payableId, totalCents, actor.id, who)
      .run();
    return jsonResponse({ payableId, totalCents });
  } catch (error) {
    console.error("Não foi possível gerar a conta a pagar do cartão do sócio.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GERAR A CONTA A PAGAR." }, 500);
  }
}
