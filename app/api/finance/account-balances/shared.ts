import { getD1 } from "../../../../db";

export type Database = Awaited<ReturnType<typeof getD1>>;

export type AccountBalance = {
  accountId: string;
  accountName: string;
  accountType: string;
  companyId: string;
  companyName: string;
  /** false = conta ativa que ainda não teve saldo informado. */
  hasBalance: boolean;
  balanceCents: number;
  asOfDate: string;
  notes: string;
  updatedByName: string;
  updatedAt: string;
};

export type AccountBalancesSnapshot = {
  accounts: AccountBalance[];
  /**
   * "Caixa Atual": soma dos saldos das contas ativas que TÊM saldo informado.
   * Conta sem saldo informado fica de fora da soma de propósito — chutar 0
   * pra ela faria o caixa mentir pra baixo sem ninguém perceber; a UI mostra
   * `accountsMissingBalance` como pendência de preenchimento.
   */
  caixaAtualCents: number;
  accountsWithBalance: number;
  accountsMissingBalance: number;
};

type BalanceRow = {
  accountId: string;
  accountName: string;
  accountType: string;
  companyId: string;
  companyName: string;
  balanceCents: number | null;
  asOfDate: string | null;
  notes: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
};

/**
 * Fonte ÚNICA do "Caixa Atual" e da lista de saldos por conta — usada tanto
 * pela tela de saldos (app/api/finance/account-balances/route.ts) quanto pela
 * projeção do Fluxo de Caixa (app/api/finance/cash-flow/route.ts). Antes as
 * duas rotas calculavam o mesmo conceito com queries diferentes (LEFT JOIN +
 * redução em JS de um lado, INNER JOIN + SUM/COUNT do outro), o que é
 * exatamente o tipo de divergência silenciosa que um número financeiro não
 * pode ter.
 *
 * O LEFT JOIN é obrigatório aqui: as contas SEM saldo precisam voltar na
 * lista (com hasBalance:false) pra virarem aviso na tela.
 */
export async function loadAccountBalances(
  database: Database,
  companyId: string,
): Promise<AccountBalancesSnapshot> {
  const rows = await database
    .prepare(
      `SELECT a.id AS accountId, a.name AS accountName, a.type AS accountType,
              a.company_id AS companyId, a.company_name AS companyName,
              b.balance_cents AS balanceCents, b.as_of_date AS asOfDate, b.notes AS notes,
              b.updated_by_name AS updatedByName, b.updated_at AS updatedAt
       FROM finance_accounts a
       LEFT JOIN finance_account_balances b ON b.account_id = a.id
       WHERE a.active = 1 ${companyId ? "AND a.company_id = ?1" : ""}
       ORDER BY a.company_name ASC, a.name ASC`,
    )
    .bind(...(companyId ? [companyId] : []))
    .all<BalanceRow>();

  const accounts: AccountBalance[] = (rows.results ?? []).map((row) => ({
    accountId: row.accountId,
    accountName: row.accountName,
    accountType: row.accountType,
    companyId: row.companyId,
    companyName: row.companyName,
    hasBalance: row.balanceCents !== null && row.balanceCents !== undefined,
    balanceCents: Number(row.balanceCents ?? 0),
    asOfDate: row.asOfDate ?? "",
    notes: row.notes ?? "",
    updatedByName: row.updatedByName ?? "",
    updatedAt: row.updatedAt ?? "",
  }));

  const withBalance = accounts.filter((account) => account.hasBalance);
  return {
    accounts,
    caixaAtualCents: withBalance.reduce((sum, account) => sum + account.balanceCents, 0),
    accountsWithBalance: withBalance.length,
    accountsMissingBalance: accounts.length - withBalance.length,
  };
}
