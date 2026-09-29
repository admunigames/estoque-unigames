import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN } from "../../../lib/commercial";
import {
  actorName,
  canManageCommercial,
  identity,
  jsonResponse,
  loadSellerForWrite,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

const MAX_CENTS = 2_000_000_000; // limite de integer no Postgres, com folga
const MAX_ITEMS = 1_000_000;

function nonNegativeInt(value: unknown, max: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) return null;
  return Math.round(number);
}

// Cadastro da meta mensal de um vendedor (upsert por vendedor + mês). A loja
// gravada é a loja atual do funcionário — a meta é "por loja".
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR METAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    const month = safeText(body.month, 7);
    const targetRevenueCents = nonNegativeInt(body.targetRevenueCents, MAX_CENTS);
    const targetItems = nonNegativeInt(body.targetItems, MAX_ITEMS);
    const targetWarrantyCents = nonNegativeInt(body.targetWarrantyCents, MAX_CENTS);
    if (!employeeId) return jsonResponse({ error: "SELECIONE O VENDEDOR." }, 400);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
    if (targetRevenueCents === null || targetItems === null || targetWarrantyCents === null) {
      return jsonResponse({ error: "INFORME METAS VÁLIDAS (ZERO OU MAIS)." }, 400);
    }

    const database = await getD1();
    const seller = await loadSellerForWrite(database, actor, employeeId);
    if ("error" in seller) return jsonResponse({ error: seller.error }, seller.status);

    await database
      .prepare(
        `INSERT INTO commercial_goals
          (id, employee_id, employee_name, company_id, company_name, month,
           target_revenue_cents, target_items, target_warranty_cents,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP, ?10, ?11, CURRENT_TIMESTAMP)
         ON CONFLICT (employee_id, month) DO UPDATE SET
           employee_name=excluded.employee_name, company_id=excluded.company_id,
           company_name=excluded.company_name, target_revenue_cents=excluded.target_revenue_cents,
           target_items=excluded.target_items, target_warranty_cents=excluded.target_warranty_cents,
           updated_by=excluded.updated_by, updated_by_name=excluded.updated_by_name,
           updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(
        crypto.randomUUID(),
        seller.employee.id,
        seller.employee.fullName,
        seller.employee.companyId,
        seller.companyName,
        month,
        targetRevenueCents,
        targetItems,
        targetWarrantyCents,
        actor.id,
        actorName(actor),
      )
      .run();
    return jsonResponse({ saved: true });
  } catch (error) {
    console.error("Não foi possível salvar a meta do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A META." }, 500);
  }
}
