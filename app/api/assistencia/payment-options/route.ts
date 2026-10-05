import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { parsePaymentOption } from "../../../lib/assistencia";
import { canManage, FORBIDDEN, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Aba PAGAMENTOS: formas de pagamento do PDF do orçamento. Sem excluir — só
// desativar (o orçamento salvo guarda a própria cópia em assist_quotes.payments).

type OptionRow = {
  id: string;
  kind: string;
  label: string;
  discountBp: number;
  installments: number;
  active: number;
  sortOrder: number;
};

const OPTION_SELECT = `
  SELECT id, kind, label, discount_bp AS discountBp, installments, active, sort_order AS sortOrder
  FROM assist_payment_options`;

function normalizeOption(row: OptionRow) {
  return {
    id: row.id,
    kind: row.kind === "credit" ? "credit" : "always",
    label: row.label,
    discountBp: Number(row.discountBp) || 0,
    installments: Math.max(1, Number(row.installments) || 1),
    active: Number(row.active) === 1,
    sortOrder: Number(row.sortOrder) || 0,
  };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManage(identity(request))) return jsonResponse({ error: FORBIDDEN }, 403);
  try {
    const database = await getD1();
    const result = await database.prepare(`${OPTION_SELECT} ORDER BY sort_order, label`).all<OptionRow>();
    return jsonResponse({ options: (result.results ?? []).map(normalizeOption) });
  } catch (error) {
    console.error("Não foi possível carregar as formas de pagamento da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS FORMAS DE PAGAMENTO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const parsed = parsePaymentOption((await request.json()) as JsonMap);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const option = parsed.option;
    const database = await getD1();
    const order = await database
      .prepare("SELECT MAX(sort_order) AS maxOrder FROM assist_payment_options")
      .first<{ maxOrder: number | string | null }>();
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO assist_payment_options
          (id, kind, label, discount_bp, installments, active, sort_order,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?7, ?8, ?9)`,
      )
      .bind(id, option.kind, option.label, option.discountBp, option.installments,
        (Number(order?.maxOrder) || 0) + 1, actor.id, actor.displayName, at)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a forma de pagamento da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A FORMA DE PAGAMENTO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const database = await getD1();
    const current = id
      ? await database.prepare(`${OPTION_SELECT} WHERE id=?1 LIMIT 1`).bind(id).first<OptionRow>()
      : null;
    if (!current) return jsonResponse({ error: "FORMA DE PAGAMENTO NÃO ENCONTRADA." }, 404);
    const parsed = parsePaymentOption(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const option = parsed.option;
    await database
      .prepare(
        `UPDATE assist_payment_options
         SET kind=?1, label=?2, discount_bp=?3, installments=?4, active=?5,
             updated_by=?6, updated_by_name=?7, updated_at=?8
         WHERE id=?9`,
      )
      .bind(option.kind, option.label, option.discountBp, option.installments, option.active ? 1 : 0,
        actor.id, actor.displayName, new Date().toISOString(), id)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível editar a forma de pagamento da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A FORMA DE PAGAMENTO." }, 500);
  }
}
