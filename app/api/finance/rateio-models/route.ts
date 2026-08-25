import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

const CONFIGURABLE_MODELS = new Set(["padrao", "administrativo"]);
const BASIS_POINTS_TOTAL = 10000;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const url = new URL(request.url);
  const model = safeText(url.searchParams.get("model"), 20);
  if (!CONFIGURABLE_MODELS.has(model)) {
    return jsonResponse({ error: "MODELO DE RATEIO INVÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        "SELECT company_id AS companyId, company_name AS companyName, percent_basis_points AS percentBasisPoints FROM finance_rateio_model_shares WHERE model=?1 ORDER BY company_id",
      )
      .bind(model)
      .all();
    return jsonResponse({ shares: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o modelo de rateio.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O MODELO DE RATEIO." }, 500);
  }
}

// Substitui TODA a configuração de um modelo de uma vez (delete + insert em
// lote) — mais simples que upsert linha a linha e evita lojas "fantasma"
// que sumiram da tela de configuração mas ficariam esquecidas no banco.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONFIGURAR O RATEIO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const model = safeText(body.model, 20);
    if (!CONFIGURABLE_MODELS.has(model)) {
      return jsonResponse({ error: "MODELO DE RATEIO INVÁLIDO." }, 400);
    }
    const sharesInput = Array.isArray(body.shares) ? body.shares : [];
    if (sharesInput.length < 2) {
      return jsonResponse({ error: "INFORME AO MENOS DUAS LOJAS COM PERCENTUAL." }, 400);
    }

    const shares: { companyId: string; companyName: string; percentBasisPoints: number }[] = [];
    let totalBp = 0;
    for (const raw of sharesInput) {
      const entry = raw as JsonMap;
      const companyId = safeText(entry.companyId, 80);
      const companyName = safeText(entry.companyName, 160);
      const percentBasisPoints = Math.round(Number(entry.percentBasisPoints));
      if (!companyId) return jsonResponse({ error: "TODAS AS LINHAS PRECISAM DE UMA LOJA SELECIONADA." }, 400);
      if (!Number.isFinite(percentBasisPoints) || percentBasisPoints < 0) {
        return jsonResponse({ error: "PERCENTUAL INVÁLIDO." }, 400);
      }
      totalBp += percentBasisPoints;
      shares.push({ companyId, companyName, percentBasisPoints });
    }
    if (totalBp !== BASIS_POINTS_TOTAL) {
      return jsonResponse({ error: "OS PERCENTUAIS PRECISAM SOMAR EXATAMENTE 100%." }, 400);
    }

    const database = await getD1();
    const actorName = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [
      ["DELETE FROM finance_rateio_model_shares WHERE model=?1", [model]],
    ];
    for (const share of shares) {
      statements.push([
        `INSERT INTO finance_rateio_model_shares
          (id, model, company_id, company_name, percent_basis_points, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP)`,
        [crypto.randomUUID(), model, share.companyId, share.companyName, share.percentBasisPoints, actor.id, actorName],
      ]);
    }
    const prepared = statements.map(([sql, values]) => database.prepare(sql).bind(...values));
    await database.batch(prepared);

    return jsonResponse({ saved: true });
  } catch (error) {
    console.error("Não foi possível salvar o modelo de rateio.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O MODELO DE RATEIO." }, 500);
  }
}
