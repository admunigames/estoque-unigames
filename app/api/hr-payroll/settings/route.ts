import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManagePayroll,
  identity,
  jsonResponse,
  loadCommissionRuleText,
  loadEmployerChargesBps,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Parâmetros globais da Folha (uma linha, company_id=''): encargos
// patronais (% sobre o salário base, entram no Custo Total) e o texto que
// descreve como a comissão é apurada (item 1) — este último é só exibição,
// não entra em nenhum cálculo.

const COMMISSION_RULE_MAX = 2000;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  }
  try {
    const database = await getD1();
    const employerChargesBps = await loadEmployerChargesBps(database);
    const commissionRuleText = await loadCommissionRuleText(database);
    return jsonResponse({ employerChargesBps, commissionRuleText });
  } catch (error) {
    console.error("Não foi possível carregar os parâmetros da folha.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PARÂMETROS DA FOLHA." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR OS PARÂMETROS DA FOLHA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const employerChargesBps = Math.round(Number(body.employerChargesBps));
    if (!Number.isFinite(employerChargesBps) || employerChargesBps < 0 || employerChargesBps > 100000) {
      return jsonResponse({ error: "INFORME UM PERCENTUAL DE ENCARGOS VÁLIDO (0 A 1000%)." }, 400);
    }
    const commissionRuleText = safeText(body.commissionRuleText, COMMISSION_RULE_MAX);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_payroll_settings WHERE company_id='' LIMIT 1")
      .first<{ id: string }>();
    if (existing) {
      await database
        .prepare(
          `UPDATE hr_payroll_settings
           SET employer_charges_bps=?1, commission_rule_text=?2, updated_by=?3, updated_by_name=?4,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=?5`,
        )
        .bind(employerChargesBps, commissionRuleText, actor.id, actorName(actor), existing.id)
        .run();
    } else {
      await database
        .prepare(
          `INSERT INTO hr_payroll_settings
            (id, company_id, employer_charges_bps, commission_rule_text, updated_by, updated_by_name,
             updated_at)
           VALUES (?1, '', ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)`,
        )
        .bind(crypto.randomUUID(), employerChargesBps, commissionRuleText, actor.id, actorName(actor))
        .run();
    }
    return jsonResponse({ saved: true, employerChargesBps, commissionRuleText });
  } catch (error) {
    console.error("Não foi possível salvar os parâmetros da folha.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR OS PARÂMETROS DA FOLHA." }, 500);
  }
}
