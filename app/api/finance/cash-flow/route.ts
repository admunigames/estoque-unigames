import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { addDays, todayInTimezone } from "../../../lib/finance-status";
import {
  buildCashFlowSeries,
  MAX_CASH_FLOW_DAYS,
  monthsInRange,
  payrollFallbackPaymentDate,
  summarizeHorizons,
  type DailyAmount,
} from "../../../lib/cash-flow";
import { canManageFinance, identity, jsonResponse, safeText } from "../shared";
import { loadEffectiveCashFlowSettings } from "../cash-flow-settings/shared";
import { loadAccountBalances } from "../account-balances/shared";

type DateAmountRow = { date: string; amountCents: number };
type MonthAmountRow = { month: string; paymentDate: string; amountCents: number };

/**
 * Numerador de placeholders por consulta. Cada prepared statement tem a
 * própria numeração (?1, ?2, ...), então montá-la incrementalmente junto com
 * o array de binds elimina a classe de bug de "índice do parâmetro fora de
 * sincronia com a posição do valor" — que é fácil de introduzir quando o
 * mesmo offset é calculado à mão em várias queries.
 */
function queryParams() {
  const values: unknown[] = [];
  return {
    values,
    /** Registra um valor e devolve o placeholder correspondente. */
    bind(value: unknown): string {
      values.push(value);
      return `?${values.length}`;
    },
  };
}

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
  const currentMonth = today.slice(0, 7);
  const lastMonth = lastDate.slice(0, 7);
  // Competências (AAAA-MM) cobertas pela janela de 90 dias — normalmente 3 ou
  // 4 meses civis. Usadas tanto pra limitar as consultas de RH quanto pra
  // projetar a folha de quem ainda não tem lançamento salvo.
  const horizonMonths = monthsInRange(today, lastDate);

  try {
    const database = await getD1();

    const [
      settings,
      receivablesPending,
      receivablesReceived,
      payablesOpen,
      payablePayments,
      payroll,
      payrollMissing,
      benefits,
      commissions,
      balances,
    ] = await Promise.all([
      // Nenhuma das consultas abaixo depende das configurações (elas só são
      // usadas depois, em payrollToDaily, que é JS puro) — por isso a leitura
      // entra no mesmo Promise.all em vez de custar um round-trip sequencial.
      loadEffectiveCashFlowSettings(database, companyId),
      // ENTRADAS — recebíveis ainda não recebidos, na data prevista.
      (() => {
        const q = queryParams();
        const dateLimit = q.bind(lastDate);
        const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
        return database
          .prepare(
            `SELECT expected_date AS date, COALESCE(SUM(expected_amount_cents), 0) AS amountCents
             FROM accounts_receivable
             WHERE canceled = 0 AND received_amount_cents IS NULL
               AND expected_date <= ${dateLimit} ${company}
             GROUP BY expected_date`,
          )
          .bind(...q.values)
          .all<DateAmountRow>();
      })(),
      // ENTRADAS — recebíveis já recebidos entram pelo VALOR e pela DATA
      // reais (nunca pelo previsto), pra não contar o mesmo recebível duas
      // vezes nem projetar um valor que já se sabe diferente.
      (() => {
        const q = queryParams();
        const from = q.bind(today);
        const to = q.bind(lastDate);
        const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
        return database
          .prepare(
            `SELECT received_date AS date, COALESCE(SUM(received_amount_cents), 0) AS amountCents
             FROM accounts_receivable
             WHERE canceled = 0 AND received_amount_cents IS NOT NULL AND received_date <> ''
               AND received_date >= ${from} AND received_date <= ${to} ${company}
             GROUP BY received_date`,
          )
          .bind(...q.values)
          .all<DateAmountRow>();
      })(),
      // SAÍDAS — saldo ainda NÃO coberto por nenhum pagamento, na data de
      // vencimento. Um pagamento AGENDADO (scheduled=1, ainda não
      // confirmado) não mexe em paid_amount_cents (ver
      // payables/[id]/payments/route.ts), então precisa ser descontado aqui
      // explicitamente: senão a mesma conta sairia duas vezes do caixa — uma
      // no vencimento e outra na data agendada. Contas canceladas ficam de
      // fora inteiras.
      (() => {
        const q = queryParams();
        const dateLimit = q.bind(lastDate);
        const company = companyId ? `AND a.company_id = ${q.bind(companyId)}` : "";
        return database
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
                 AND a.due_date <= ${dateLimit} ${company}
             ) AS open_balances
             GROUP BY due_date`,
          )
          .bind(...q.values)
          .all<DateAmountRow>();
      })(),
      // SAÍDAS — pagamentos registrados, na data do próprio pagamento:
      //  - agendados ainda não confirmados: entram sempre (um agendamento
      //    atrasado é bucketizado no primeiro dia da série, não some);
      //  - confirmados: só os de hoje em diante — o que já foi pago no
      //    passado já saiu do caixa e portanto já está no saldo informado
      //    das contas, somá-lo de novo derrubaria a projeção duas vezes.
      (() => {
        const q = queryParams();
        const from = q.bind(today);
        const to = q.bind(lastDate);
        const company = companyId ? `AND a.company_id = ${q.bind(companyId)}` : "";
        return database
          .prepare(
            `SELECT p.payment_date AS date, COALESCE(SUM(p.amount_cents), 0) AS amountCents
             FROM accounts_payable_payments p
             JOIN accounts_payable a ON a.id = p.payable_id
             WHERE a.status <> 'canceled' AND p.payment_date <= ${to}
               AND ((p.scheduled = 1 AND p.confirmed_at = '')
                    OR (p.confirmed_at <> '' AND p.payment_date >= ${from}))
               ${company}
             GROUP BY p.payment_date`,
          )
          .bind(...q.values)
          .all<DateAmountRow>();
      })(),
      // SAÍDAS — RH: folha já lançada. O total líquido segue a mesma fórmula
      // de app/api/hr-payroll/entries/route.ts (netCentsFor): as adições
      // somam e deductions_cents é guardado como MAGNITUDE positiva, por isso
      // é subtraído. Comissões e benefícios NÃO entram aqui (vêm nas próprias
      // consultas abaixo, senão seriam contados duas vezes).
      //
      // Dois recortes obrigatórios, senão a projeção vira ficção:
      //  - LIMITE INFERIOR de competência (mês corrente): sem ele, anos de
      //    folha já paga entrariam na consulta e, como bucketDate joga toda
      //    data anterior a hoje no dia 0 da série, apareceriam como se
      //    fossem sair do caixa hoje.
      //  - lançamento JÁ PAGO no passado fica de fora pelo mesmo motivo da
      //    consulta de accounts_payable_payments acima: o dinheiro já saiu e
      //    já está refletido no saldo manual das contas.
      (() => {
        const q = queryParams();
        const from = q.bind(currentMonth);
        const to = q.bind(lastMonth);
        const paidCutoff = q.bind(today);
        const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
        return database
          .prepare(
            `SELECT month, payment_date AS paymentDate,
                    COALESCE(SUM(base_salary_cents + bonus_cents + overtime_cents + additions_cents
                                 + other_cents - deductions_cents), 0) AS amountCents
             FROM hr_payroll_entries
             WHERE month >= ${from} AND month <= ${to}
               AND NOT (payment_done = 1 AND payment_date <> '' AND payment_date < ${paidCutoff})
               ${company}
             GROUP BY month, payment_date`,
          )
          .bind(...q.values)
          .all<MonthAmountRow>();
      })(),
      // SAÍDAS — RH: folha AINDA NÃO lançada. A linha em hr_payroll_entries
      // só passa a existir quando alguém abre e salva a Folha daquele mês, e
      // o mês que vem quase nunca está lançado — sem este fallback o Fluxo de
      // Caixa projetaria R$ 0,00 de folha justamente nos meses futuros, que
      // são os que importam. Usa salary_cents do cadastro como valor base,
      // exatamente como a própria tela de Folha já faz
      // (app/api/hr-payroll/entries/route.ts) quando não há lançamento.
      //
      // Sem bônus/comissão/desconto de propósito: não existe lançamento
      // nenhum pra esses meses, então qualquer valor além do salário-base
      // seria inventado. Benefícios e comissões NÃO ganham fallback pelo
      // mesmo motivo — são valores variáveis/discricionários, sem padrão
      // conhecido de antemão.
      (() => {
        const q = queryParams();
        const monthsUnion = horizonMonths
          .map((month) => `SELECT ${q.bind(month)}::text AS month`)
          .join(" UNION ALL ");
        const company = companyId ? `AND e.company_id = ${q.bind(companyId)}` : "";
        return database
          .prepare(
            `SELECT months.month AS month, '' AS paymentDate,
                    COALESCE(SUM(e.salary_cents), 0) AS amountCents
             FROM hr_employees e
             CROSS JOIN (${monthsUnion}) AS months
             WHERE e.status = 'active' ${company}
               AND NOT EXISTS (
                 SELECT 1 FROM hr_payroll_entries p
                 WHERE p.employee_id = e.id AND p.month = months.month
               )
             GROUP BY months.month`,
          )
          .bind(...q.values)
          .all<MonthAmountRow>();
      })(),
      // SAÍDAS — RH: benefícios. hr_benefits não tem payment_done (só
      // payment_date), então "já pago no passado" é decidido pela data.
      (() => {
        const q = queryParams();
        const from = q.bind(currentMonth);
        const to = q.bind(lastMonth);
        const paidCutoff = q.bind(today);
        const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
        return database
          .prepare(
            `SELECT month, payment_date AS paymentDate, COALESCE(SUM(amount_cents), 0) AS amountCents
             FROM hr_benefits
             WHERE month >= ${from} AND month <= ${to}
               AND NOT (payment_date <> '' AND payment_date < ${paidCutoff})
               ${company}
             GROUP BY month, payment_date`,
          )
          .bind(...q.values)
          .all<MonthAmountRow>();
      })(),
      // SAÍDAS — RH: comissionamento. Não tem data de pagamento própria no
      // cadastro, então usa SEMPRE a regra do dia fixo configurável sobre o
      // mês de competência — mesma regra da folha/benefício sem payment_date.
      // Por não ter data de pagamento, também não há como excluir "já pago":
      // o limite inferior de competência é o único recorte possível.
      // Fórmula do líquido idêntica a commissionNetCents()
      // (app/api/hr-payroll/shared.ts): descontos são magnitude positiva e
      // saem subtraídos; ajustes já vêm com sinal.
      (() => {
        const q = queryParams();
        const from = q.bind(currentMonth);
        const to = q.bind(lastMonth);
        const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
        return database
          .prepare(
            `SELECT month, '' AS paymentDate,
                    COALESCE(SUM(commission_cents + bonuses_cents + premiums_cents
                                 - discounts_cents + adjustments_cents), 0) AS amountCents
             FROM hr_commissions
             WHERE month >= ${from} AND month <= ${to} ${company}
             GROUP BY month`,
          )
          .bind(...q.values)
          .all<MonthAmountRow>();
      })(),
      // Caixa Atual + contas sem saldo informado, pela MESMA função que
      // alimenta a tela de saldos (app/api/finance/account-balances/shared.ts)
      // — o número não pode divergir entre as duas telas.
      loadAccountBalances(database, companyId),
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

    const series = buildCashFlowSeries({
      today,
      days: MAX_CASH_FLOW_DAYS,
      caixaAtualCents: balances.caixaAtualCents,
      entradas: [...toDaily(receivablesPending), ...toDaily(receivablesReceived)],
      saidasPayables: [...toDaily(payablesOpen), ...toDaily(payablePayments)],
      saidasPayroll: [
        ...payrollToDaily(payroll),
        ...payrollToDaily(payrollMissing),
        ...payrollToDaily(benefits),
        ...payrollToDaily(commissions),
      ],
    });

    return jsonResponse({
      companyId,
      today,
      settings,
      caixaAtualCents: balances.caixaAtualCents,
      accountsWithBalance: balances.accountsWithBalance,
      accountsMissingBalance: balances.accountsMissingBalance,
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
