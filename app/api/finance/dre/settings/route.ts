import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { isAutoRateioModel } from "../../../../lib/rateio-models";
import { canManageFinance, identity, jsonResponse, sameOrigin, type JsonMap } from "../../shared";
import { loadOverheadSettings, OVERHEAD_SETTINGS_KEY } from "../payroll";

// Modelo de rateio do custo de funcionários do DEPÓSITO e do ESCRITÓRIO na DRE.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManageFinance(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  try {
    return jsonResponse({ overhead: await loadOverheadSettings(await getD1()) });
  } catch (error) {
    console.error("Não foi possível carregar as configurações da DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CONFIGURAÇÕES DA DRE." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManageFinance(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O FINANCEIRO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const overhead = (body.overhead || {}) as JsonMap;
    if (!isAutoRateioModel(overhead.deposito) || !isAutoRateioModel(overhead.escritorio)) {
      return jsonResponse({ error: "ESCOLHA O MODELO DE RATEIO DO DEPÓSITO E DO ESCRITÓRIO." }, 400);
    }
    const value = JSON.stringify({ deposito: overhead.deposito, escritorio: overhead.escritorio });
    const database = await getD1();
    await database
      .prepare(
        `INSERT INTO shared_state (state_key, value_json, version, updated_at) VALUES (?1, ?2, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (state_key) DO UPDATE SET value_json=excluded.value_json, version=shared_state.version + 1, updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(OVERHEAD_SETTINGS_KEY, value)
      .run();
    return jsonResponse({ overhead: JSON.parse(value) });
  } catch (error) {
    console.error("Não foi possível gravar as configurações da DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR AS CONFIGURAÇÕES DA DRE." }, 500);
  }
}
