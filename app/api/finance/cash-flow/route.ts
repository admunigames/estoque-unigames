import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { addDays, todayInTimezone } from "../../../lib/finance-status";
import {
  buildCashFlowSeries,
  MAX_CASH_FLOW_DAYS,
  payrollFallbackPaymentDate,
  summarizeHorizons,
  type DailyAmount,
} from "../../../lib/cash-flow";
import { canManageFinance, identity, jsonResponse, safeText } from "../shared";
import { loadEffectiveCashFlowSettings } from "../cash-flow-settings/shared";

type DateAmountRow = { date: string; amountCents: number };
type MonthAmountRow = { month: string; paymentDate: string; amountCents: number };

// Fluxo de Caixa (Financeiro Fase 6).
//
// Esta rota é SÓ I/O: busca os agregados por dia de cada fonte e entrega pra
// função pura buildCashFlowSeries (app/lib/cash-flow.ts) montar a projeção.
// Retorna sempre a série completa de 90 dias — a UI recorta os horizontes de
// 7/15/30/60/90 dias a partir dela, sem nenhum recálculo.
//
// SAÍDAS (ver [[estoque_modulo_contas_a_pagar]]): Contas a Pagar,
// Fornecedores em Aberto e Despesas (avulsas, parceladas, recorrentes ou
// rateadas) TODAS acabam materializadas em accounts_payable, então uma única
// consulta unificada sobre accounts_payable + accounts_payable_payments cobre
// os três módulos. Pra não contar a mesma conta duas vezes:
//   - o saldo AINDA NÃO coberto por pagamento (original - paid) sai na
//     due_date;
//   - o valor JÁ coberto por pagamentos (parciais ou totais, confirmados ou
//     agendados) sai na payment_date de cada pagamento.
// RH Financeiro (folha/benefícios/comissões) não tem ligação nenhuma com
// accounts_payable, então é somado separadamente.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const params = new URL(request.url).searchParams;
  const requestedCompanyId = safeText(params.get("companyId"), 80);
  if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const companyId = allStores ? requestedCompanyId : scopeActor.companyId;

  const today = todayInTimezone();
  const lastDate = addDays(today, MAX_CASH_FLOW_DAYS - 1);
  // Movimentos atrasados (data anterior a hoje) NÃO são descartados: as
  // consultas abaixo não têm limite inferior de data e buildCashFlowSeries
  // soma tudo que ficou pra trás no PRIMEIRO dia da série. Ignorá-los
  // esconderia dinheiro que ainda vai sair/entrar; espalhá-los pelo futuro
  // seria inventar uma data que ninguém informou.

  const companyFilter = (alias: string) => (companyId ? `AND ${alias}company_id = ?1` : "");
  const companyParams: unknown[] = companyId ? [companyId] : [];
  const p = (offset: number) => `?${companyParams.length + offset}`;

  try {
    const database = await getD1();
    const settings = await loadEffectiveCashFlowSettings(database, companyId);

    const [
      receivablesPending,
      receivablesReceived,
      payablesOpen,
      payablePayments,
      payroll,
      benefits,
      commissions,
      balancesRow,
    ] = await Promise.all([
      // ENTRADAS — recebíveis ainda não recebidos, na data prevista.
      database
        .prepare(
          `SELECT expected_date AS date, COALESCE(SUM(expected_amount_cents), 0) AS amountCents
           FROM accounts_receivable
           WHERE canceled = 0 AND received_amount_cents IS NULL
             AND expected_date <= ${p(1)} ${companyFilter("")}
           GROUP BY expected_date`,
        )
        .bind(...companyParams, lastDate)
        .all<DateAmountRow>(),
      // ENTRADAS — recebíveis já recebidos entram pelo VALOR e pela DATA
      // reais (nunca pelo previsto), pra não contar o mesmo recebível duas
      // vezes nem projetar um valor que já se sabe diferente.
      database
        .prepare(
          `SELECT received_date AS date, COALESCE(SUM(received_amount_cents), 0) AS amountCents
           FROM accounts_receivable
           WHERE canceled = 0 AND received_amount_cents IS NOT NULL AND received_date <> ''
             AND received_date >= ${p(1)} AND received_date <= ${p(2)} ${companyFilter("")}
           GROUP BY received_date`,
        )
        .bind(...companyParams, today, lastDate)
        .all<DateAmountRow>(),
      // SAÍDAS — saldo ainda NÃO coberto por nenhum pagamento, na data de
      // vencimento. Um pagamento AGENDADO (scheduled=1, ainda não
      // confirmado) não mexe em paid_amount_cents (ver
      // payables/[id]/payments/route.ts), então precisa ser descontado aqui
      // explicitamente: senão a mesma conta sairia duas vezes do caixa — uma
      // no vencimento e outra na data agendada. Contas canceladas ficam de
      // fora inteiras.
      database
        .prepare(
          `SELECT due_date AS date, COALESCE(SUM(uncovered), 0) AS amountCents
           FROM (
             SELECT a.due_date,
                    GREATEST(
                      a.original_amount_cents - a.paid_amount_cents - COALESCE((
                        SELECT SUM(s.amount_cents) FROM accounts_payable_payments s
                        WHERE s.payable_id = a.id AND s.scheduled = 1 AND s.confirmed_at = ''
                      ), 0),
                      0
                    ) AS uncovered
             FROM accounts_payable a
             WHERE a.status NOT IN ('canceled', 'paid')
               AND a.original_amount_cents > a.paid_amount_cents
               AND a.due_date <= ${p(1)} ${companyFilter("a.")}
           ) AS open_balances
           GROUP BY due_date`,
        )
        .bind(...companyParams, lastDate)
        .all<DateAmountRow>(),
      // SAÍDAS — pagamentos registrados, na data do próprio pagamento:
      //  - agendados ainda não confirmados: entram sempre (um agendamento
      //    atrasado é bucketizado no primeiro dia da série, não some);
      //  - confirmados: só os de hoje em diante — o que já foi pago no
      //    passado já saiu do caixa e portanto já está no saldo informado
      //    das contas, somá-lo de novo derrubaria a projeção duas vezes.
      database
        .prepare(
          `SELECT p.payment_date AS date, COALESCE(SUM(p.amount_cents), 0) AS amountCents
           FROM accounts_payable_payments p
           JOIN accounts_payable a ON a.id = p.payable_id
           WHERE a.status <> 'canceled' AND p.payment_date <= ${p(2)}
             AND ((p.scheduled = 1 AND p.confirmed_at = '')
                  OR (p.confirmed_at <> '' AND p.payment_date >= ${p(1)}))
             ${companyId ? "AND a.company_id = ?1" : ""}
           GROUP BY p.payment_date`,
        )
        .bind(...companyParams, today, lastDate)
        .all<DateAmountRow>(),
      // SAÍDAS — RH: folha. O total líquido segue a mesma fórmula de
      // app/api/hr-payroll/entries/route.ts (netCentsFor): as adições somam e
      // deductions_cents é guardado como MAGNITUDE positiva, por isso é
      // subtraído. Comissões e benefícios NÃO entram aqui (vêm nas próprias
      // consultas abaixo, senão seriam contados duas vezes).
      database
        .prepare(
          `SELECT month, payment_date AS paymentDate,
                  COALESCE(SUM(base_salary_cents + bonus_cents + overtime_cents + additions_cents
                               + other_cents - deductions_cents), 0) AS amountCents
           FROM hr_payroll_entries
           WHERE month <= ${p(1)} ${companyFilter("")}
           GROUP BY month, payment_date`,
        )
        .bind(...companyParams, lastDate.slice(0, 7))
        .all<MonthAmountRow>(),
      database
        .prepare(
          `SELECT month, payment_date AS paymentDate, COALESCE(SUM(amount_cents), 0) AS amountCents
           FROM hr_benefits
           WHERE month <= ${p(1)} ${companyFilter("")}
           GROUP BY month, payment_date`,
        )
        .bind(...companyParams, lastDate.slice(0, 7))
        .all<MonthAmountRow>(),
      // Comissionamento não tem data de pagamento própria no cadastro, então
      // usa SEMPRE a regra do dia fixo configurável sobre o mês de
      // competência — mesma regra da folha/benefício sem payment_date.
      // Fórmula do líquido idêntica a commissionNetCents()
      // (app/api/hr-payroll/shared.ts): descontos são magnitude positiva e
      // saem subtraídos; ajustes já vêm com sinal.
      database
        .prepare(
          `SELECT month, '' AS paymentDate,
                  COALESCE(SUM(commission_cents + bonuses_cents + premiums_cents
                               - discounts_cents + adjustments_cents), 0) AS amountCents
           FROM hr_commissions
           WHERE month <= ${p(1)} ${companyFilter("")}
           GROUP BY month`,
        )
        .bind(...companyParams, lastDate.slice(0, 7))
        .all<MonthAmountRow>(),
      // Caixa Atual: soma dos saldos informados manualmente das contas ATIVAS
      // no escopo. Conta sem saldo informado não entra na soma (a tela de
      // saldos destaca essas contas como pendência).
      database
        .prepare(
          `SELECT COALESCE(SUM(b.balance_cents), 0) AS totalCents,
                  COUNT(b.account_id) AS withBalance,
                  (SELECT COUNT(*) FROM finance_accounts a2
                    WHERE a2.active = 1 ${companyId ? "AND a2.company_id = ?1" : ""}) AS totalAccounts
           FROM finance_accounts a
           JOIN finance_account_balances b ON b.account_id = a.id
           WHERE a.active = 1 ${companyFilter("a.")}`,
        )
        .bind(...companyParams)
        .first<{ totalCents: number; withBalance: number; totalAccounts: number }>(),
    ]);

    function toDaily(rows: { results?: DateAmountRow[] }): DailyAmount[] {
      return (rows.results ?? [])
        .filter((row) => Boolean(row.date))
        .map((row) => ({ date: row.date, amountCents: Number(row.amountCents || 0) }));
    }

    /**
     * Lançamentos de RH viram uma saída datada: pela payment_date quando ela
     * foi preenchida (o pagamento realmente aconteceu naquele dia), senão
     * pelo dia fixo configurado do mês seguinte à competência — regra
     * confirmada com o usuário.
     */
    function payrollToDaily(rows: { results?: MonthAmountRow[] }): DailyAmount[] {
      return (rows.results ?? [])
        .map((row) => {
          const amountCents = Number(row.amountCents || 0);
          if (!amountCents) return null;
          const paymentDate = safeText(row.paymentDate, 10);
          const date = /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
            ? paymentDate
            : payrollFallbackPaymentDate(row.month, settings.payrollDefaultPaymentDay);
          return { date, amountCents };
        })
        .filter((row): row is DailyAmount => row !== null);
    }

    const caixaAtualCents = Number(balancesRow?.totalCents ?? 0);
    const series = buildCashFlowSeries({
      today,
      days: MAX_CASH_FLOW_DAYS,
      caixaAtualCents,
      entradas: [...toDaily(receivablesPending), ...toDaily(receivablesReceived)],
      saidasPayables: [...toDaily(payablesOpen), ...toDaily(payablePayments)],
      saidasPayroll: [
        ...payrollToDaily(payroll),
        ...payrollToDaily(benefits),
        ...payrollToDaily(commissions),
      ],
    });

    const accountsWithBalance = Number(balancesRow?.withBalance ?? 0);
    const totalAccounts = Number(balancesRow?.totalAccounts ?? 0);

    return jsonResponse({
      companyId,
      today,
      settings,
      caixaAtualCents,
      accountsWithBalance,
      accountsMissingBalance: Math.max(0, totalAccounts - accountsWithBalance),
      days: series.days,
      horizons: summarizeHorizons(series),
      // A tela avisa que a fórmula ainda está incompleta neste ponto: o
      // módulo de Impostos e Taxas de cartão chega na Fase 7 e por enquanto
      // contribui com 0 (ver saidasImpostosTaxasCents em app/lib/cash-flow.ts).
      taxesAndFeesIncluded: false,
    });
  } catch (error) {
    console.error("Não foi possível carregar o fluxo de caixa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O FLUXO DE CAIXA." }, 500);
  }
}
