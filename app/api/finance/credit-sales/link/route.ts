import { getD1 } from "../../../../../db";
import { creditSaleStatus, suggestCreditSalesForDeposit, withDepositNote } from "../../../../lib/credit-sales";
import { allocateDeposit, depositMatchesKeyword } from "../../../../lib/sales-recon";
import { jsonResponse, MONTH_PATTERN, safeText, type JsonMap } from "../../shared";
import { runStatements, type Statement } from "../../card-fees/shared";
import {
  bodyIds,
  CREDIT_SALE_COLUMNS,
  creditScope,
  inScope,
  loadCreditSalesByIds,
  loadProviders,
  normalizeCreditSale,
  type CreditSaleRow,
} from "../shared";
import { monthRange } from "../../sales-recon/shared";

// CLASSIFICAR EXTRATO (Crediários, Financeiro 7/9).
// GET ?financeAccountId&month&companyId (ou ?entryId): ENTRADAS do extrato
//   ainda a classificar, com a financeira provável (texto no extrato) e a
//   sugestão de crediários; + os crediários PENDENTES para o diálogo.
// POST { bankEntryId, creditSaleIds[] }: numa transação, os crediários ficam
//   FINALIZADOS com a data do depósito e o recebido (depósito rateado se a
//   soma não bater — a diferença vai para a observação) e a entrada vira
//   'credit_sale' com in_dre 0 (a receita já está no faturamento).

const OPEN_STATUSES = ["pending", "classified"];

type EntryRow = {
  id: string;
  financeAccountId: string;
  accountName: string;
  companyId: string;
  entryDate: string;
  description: string;
  amountCents: number;
  status: string;
};

const ENTRY_COLUMNS = `e.id, e.finance_account_id AS financeAccountId, a.name AS accountName, e.company_id AS companyId,
  e.entry_date AS entryDate, e.description, e.amount_cents AS amountCents, e.status`;

function brl(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const [int, dec] = (Math.abs(cents) / 100).toFixed(2).split(".");
  return `${sign}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

export async function GET(request: Request) {
  const scope = creditScope(request, false);
  if (scope instanceof Response) return scope;
  const params = new URL(request.url).searchParams;
  try {
    const database = await getD1();
    const conditions: string[] = [];
    const values: unknown[] = [];
    const entryId = safeText(params.get("entryId"), 80);
    if (entryId) {
      values.push(entryId);
      conditions.push(`e.id=?${values.length}`);
    } else {
      conditions.push(`e.amount_cents > 0 AND e.status IN ('pending','classified')`);
      const accountId = safeText(params.get("financeAccountId"), 80);
      if (accountId) {
        values.push(accountId);
        conditions.push(`e.finance_account_id=?${values.length}`);
      }
      const month = safeText(params.get("month"), 7);
      if (MONTH_PATTERN.test(month)) {
        const range = monthRange(month);
        values.push(range.from, range.to);
        conditions.push(`e.entry_date >= ?${values.length - 1} AND e.entry_date <= ?${values.length}`);
      }
    }
    const companyId = scope.allStores ? safeText(params.get("companyId"), 80) : scope.companyId;
    if (companyId) {
      values.push(companyId);
      conditions.push(`e.company_id=?${values.length}`);
    }
    const [entries, providers, pendingResult] = await Promise.all([
      database
        .prepare(
          `SELECT ${ENTRY_COLUMNS} FROM finance_bank_statement_entries e
           LEFT JOIN finance_accounts a ON a.id = e.finance_account_id
           WHERE ${conditions.join(" AND ")} ORDER BY e.entry_date DESC, e.id ASC LIMIT 2000`,
        )
        .bind(...values)
        .all<EntryRow>(),
      loadProviders(database, scope),
      database
        .prepare(
          `SELECT ${CREDIT_SALE_COLUMNS} FROM finance_credit_sales
           WHERE canceled=0 AND received_date='' ${scope.allStores ? "" : "AND company_id=?1"} ORDER BY sale_date ASC`,
        )
        .bind(...(scope.allStores ? [] : [scope.companyId]))
        .all<CreditSaleRow>(),
    ]);
    const pending = (pendingResult.results ?? []).map(normalizeCreditSale);
    const keywordProviders = providers.filter((row) => row.status === "active" && row.bankKeyword.trim());
    return jsonResponse({
      entries: (entries.results ?? []).map((entry) => {
        const amountCents = Number(entry.amountCents);
        const provider = keywordProviders.find((row) => depositMatchesKeyword(entry.description, row.bankKeyword));
        return {
          ...entry,
          amountCents,
          providerId: provider?.id ?? "",
          providerName: provider?.name ?? "",
          suggestedIds: amountCents > 0 ? suggestCreditSalesForDeposit(amountCents, pending, provider?.id ?? "") : [],
        };
      }),
      pending,
    });
  } catch (error) {
    console.error("Não foi possível carregar as entradas do extrato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS ENTRADAS DO EXTRATO." }, 500);
  }
}

export async function POST(request: Request) {
  const scope = creditScope(request, true);
  if (scope instanceof Response) return scope;
  try {
    const body = (await request.json()) as JsonMap;
    const bankEntryId = safeText(body.bankEntryId, 80);
    const ids = bodyIds(body.creditSaleIds);
    if (!bankEntryId) return jsonResponse({ error: "ESCOLHA A ENTRADA DO EXTRATO." }, 400);
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM CREDIÁRIO." }, 400);
    if (ids.length > 200) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 200)." }, 400);

    const database = await getD1();
    const entry = await database
      .prepare(
        `SELECT id, company_id AS companyId, entry_date AS entryDate, amount_cents AS amountCents, status
         FROM finance_bank_statement_entries WHERE id=?1`,
      )
      .bind(bankEntryId)
      .first<{ id: string; companyId: string; entryDate: string; amountCents: number; status: string }>();
    if (!entry) return jsonResponse({ error: "LANÇAMENTO DO EXTRATO NÃO ENCONTRADO." }, 404);
    if (!inScope(scope, entry.companyId)) return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSE LANÇAMENTO." }, 403);
    const depositCents = Number(entry.amountCents);
    if (depositCents <= 0) return jsonResponse({ error: "SÓ ENTRADAS (VALOR POSITIVO) PODEM SER CREDIÁRIO." }, 400);
    if (entry.status === "credit_sale") return jsonResponse({ error: "ESSA ENTRADA JÁ ESTÁ VINCULADA A CREDIÁRIO." }, 409);
    if (!OPEN_STATUSES.includes(entry.status)) {
      return jsonResponse({ error: "ESSA ENTRADA JÁ FOI CLASSIFICADA NA CONCILIAÇÃO BANCÁRIA." }, 409);
    }

    const sales = await loadCreditSalesByIds(database, ids);
    if (sales.length !== ids.length) return jsonResponse({ error: "ALGUM CREDIÁRIO SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    if (sales.some((row) => !inScope(scope, row.companyId))) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ALGUM CREDIÁRIO SELECIONADO." }, 403);
    }
    const notPending = sales.find((row) => creditSaleStatus(row) !== "pending");
    if (notPending) return jsonResponse({ error: `O CREDIÁRIO DA PROPOSTA ${notPending.proposal} NÃO ESTÁ PENDENTE.` }, 409);

    const totalCents = sales.reduce((sum, row) => sum + row.netCents, 0);
    const differenceCents = depositCents - totalCents;
    const shares = allocateDeposit(depositCents, sales.map((row) => ({ id: row.id, netCents: row.netCents })));
    const actor = scope.actor;
    const who = actor.displayName || "Administrador";
    const note = differenceCents
      ? `DEPÓSITO DE ${brl(depositCents)} EM ${entry.entryDate.split("-").reverse().join("/")} PARA ${sales.length} CREDIÁRIO(S) QUE SOMAM ${brl(totalCents)} — DIFERENÇA ${brl(differenceCents)}.`
      : "";
    const statements: Statement[] = sales.map((row) => [
      `UPDATE finance_credit_sales SET bank_entry_id=?1, received_date=?2, received_cents=?3, notes=?4,
         updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP WHERE id=?7`,
      [bankEntryId, entry.entryDate, differenceCents ? (shares.get(row.id) ?? 0) : row.netCents,
        note ? withDepositNote(row.notes, note) : row.notes, actor.id, who, row.id],
    ]);
    statements.push([
      `UPDATE finance_bank_statement_entries SET status='credit_sale', in_dre=0, updated_by=?2, updated_by_name=?3,
         updated_at=CURRENT_TIMESTAMP WHERE id=?1`,
      [bankEntryId, actor.id, who],
    ]);
    await runStatements(database, statements);
    return jsonResponse({ linked: sales.length, depositCents, totalCents, differenceCents });
  } catch (error) {
    console.error("Não foi possível vincular o depósito aos crediários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL VINCULAR O DEPÓSITO AOS CREDIÁRIOS." }, 500);
  }
}
