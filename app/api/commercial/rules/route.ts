import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { DEFAULT_COMMERCIAL_RULES, parseCommercialRules } from "../../../lib/commercial";
import {
  actorName,
  canAccessCommercial,
  canManageCommercialRules,
  identity,
  jsonResponse,
  loadRules,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Regras de comissão por VIGÊNCIA (aba Regras de Comissão). Leitura para
// qualquer permissão do Comercial (os textos das regras vêm daqui); criar e
// editar só com comercial:rules. Uma vigência vale do mês dela em diante,
// até a próxima; meses sem nenhuma vigência usam a regra padrão do código.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }
  try {
    const items = await loadRules(await getD1());
    return jsonResponse({ items, defaults: DEFAULT_COMMERCIAL_RULES, canManage: canManageCommercialRules(actor) });
  } catch (error) {
    console.error("Não foi possível carregar as regras de comissão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS REGRAS DE COMISSÃO." }, 500);
  }
}

async function save(request: Request, method: "POST" | "PUT") {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercialRules(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR AS REGRAS DE COMISSÃO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const { rules, error } = parseCommercialRules(body);
    if (!rules) return jsonResponse({ error }, 400);
    const id = method === "PUT" ? safeText(body.id, 80) : crypto.randomUUID();
    const notes = safeText(body.notes, 500);
    const database = await getD1();
    if (method === "PUT") {
      const current = await database.prepare("SELECT id FROM commercial_rules WHERE id=?1").bind(id).first();
      if (!current) return jsonResponse({ error: "VIGÊNCIA NÃO ENCONTRADA." }, 404);
    }
    const clash = await database
      .prepare("SELECT id FROM commercial_rules WHERE valid_from=?1")
      .bind(rules.validFrom)
      .first<{ id: string }>();
    if (clash && clash.id !== id) {
      const [year, month] = rules.validFrom.split("-");
      return jsonResponse({ error: `JÁ EXISTE UMA VIGÊNCIA A PARTIR DE ${month}/${year} — EDITE ESSA.` }, 409);
    }
    const values = [
      rules.validFrom, rules.revenueRateHighBps, rules.revenueRateLowBps, JSON.stringify(rules.premiumTiers),
      rules.warrantyRateBps, rules.warrantyAttachTarget, rules.creditRateBps, notes,
      actor.id, actorName(actor), new Date().toISOString(), id,
    ];
    await database
      .prepare(
        method === "POST"
          ? `INSERT INTO commercial_rules
              (valid_from, revenue_rate_high_bps, revenue_rate_low_bps, premium_tiers_json, warranty_rate_bps,
               warranty_attach_target, credit_rate_bps, notes, updated_by, updated_by_name, updated_at, id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
          : `UPDATE commercial_rules SET valid_from=?1, revenue_rate_high_bps=?2, revenue_rate_low_bps=?3,
               premium_tiers_json=?4, warranty_rate_bps=?5, warranty_attach_target=?6, credit_rate_bps=?7,
               notes=?8, updated_by=?9, updated_by_name=?10, updated_at=?11
             WHERE id=?12`,
      )
      .bind(...values)
      .run();
    return jsonResponse({ id }, method === "POST" ? 201 : 200);
  } catch (error) {
    console.error("Não foi possível salvar a regra de comissão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A REGRA DE COMISSÃO." }, 500);
  }
}

export function POST(request: Request) {
  return save(request, "POST");
}

export function PUT(request: Request) {
  return save(request, "PUT");
}
