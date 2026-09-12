import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse } from "../shared";

// Cards de números gerais na tela inicial da aba Compras (Por Produto, sem
// busca) — pedido do usuário depois de ver a tela em branco: "apresentar
// dados gerais" antes de qualquer busca, sem gráfico por enquanto. Só conta
// pedidos NATIVOS não cancelados; pedidos importados do Notion ficam de
// fora (são histórico fechado, sempre concluído/sem itens).
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  try {
    const database = await getD1();
    const today = new Date().toISOString().slice(0, 10);

    const counts = await database
      .prepare(
        `SELECT status, expected_date AS expectedDate, COUNT(*) AS total
         FROM purchase_orders
         WHERE origin='native' AND canceled=0
         GROUP BY status, expected_date`,
      )
      .all<{ status: string; expectedDate: string; total: number }>();
    const rows = counts.results ?? [];

    let abertos = 0;
    let aguardandoChegada = 0;
    let atrasados = 0;
    let concluidos = 0;
    for (const row of rows) {
      const total = Number(row.total) || 0;
      if (row.status === "aberto") abertos += total;
      else if (row.status === "aguardando_chegada") {
        aguardandoChegada += total;
        if (row.expectedDate && row.expectedDate < today) atrasados += total;
      } else if (row.status === "concluido") concluidos += total;
    }

    return jsonResponse({ abertos, aguardandoChegada, atrasados, concluidos });
  } catch (error) {
    console.error("Não foi possível carregar os números gerais de Compras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS NÚMEROS GERAIS." }, 500);
  }
}
