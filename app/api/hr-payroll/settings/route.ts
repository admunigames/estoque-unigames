import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManagePayroll,
  identity,
  jsonResponse,
  loadEmployerChargesBps,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Parâmetros globais da Folha (uma linha, company_id=''). Hoje só os
// encargos patronais (% sobre o salário base) que entram no Custo Total.

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
    return jsonResponse({ employerChargesBps });
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

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_payroll_settings WHERE company_id='' LIMIT 1")
      .first<{ id: string }>();
    if (existing) {
      await database
        .prepare(
          `UPDATE hr_payroll_settings
           SET employer_charges_bps=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
           WHERE id=?4`,
        )
        .bind(employerChargesBps, actor.id, actorName(actor), existing.id)
        .run();
    } else {
      await database
        .prepare(
          `INSERT INTO hr_payroll_settings
            (id, company_id, employer_charges_bps, updated_by, updated_by_name, updated_at)
           VALUES (?1, '', ?2, ?3, ?4, CURRENT_TIMESTAMP)`,
        )
        .bind(crypto.randomUUID(), employerChargesBps, actor.id, actorName(actor))
        .run();
    }
    return jsonResponse({ saved: true, employerChargesBps });
  } catch (error) {
    console.error("Não foi possível salvar os parâmetros da folha.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR OS PARÂMETROS DA FOLHA." }, 500);
  }
}
