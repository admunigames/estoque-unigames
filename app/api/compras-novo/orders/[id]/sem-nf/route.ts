import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText, sameOrigin, semNfKey } from "../../../shared";

// Pedido que NÃO vai ter NF vinculada (ex.: compra sem nota): sai do
// FALTA VINCULAR NF do painel. Uma linha de shared_state por pedido
// (semNfKey) — marcar = gravar, desmarcar = apagar, sem
// migration e sem disputa entre duas pessoas marcando pedidos diferentes.
//   POST   → marca SEM NF   (→ { noInvoice: { byName, at } })
//   DELETE → volta a exigir NF

async function guard(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR PEDIDOS DE COMPRA." }, 403) };
  }
  if (!sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  const orderId = safeText((await context.params).id, 80);
  const database = await getD1();
  const order = await database.prepare("SELECT id FROM purchase_orders WHERE id=?1").bind(orderId).first<{ id: string }>();
  if (!order) return { error: jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404) };
  return { actor, orderId, database };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const checked = await guard(request, context);
  if ("error" in checked) return checked.error;
  const { actor, orderId, database } = checked;
  try {
    const noInvoice = { byName: actor.displayName || "Usuário", at: new Date().toISOString() };
    await database
      .prepare(
        `INSERT INTO shared_state (state_key, value_json, version, updated_at) VALUES (?1, ?2, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (state_key) DO UPDATE SET value_json=excluded.value_json, version=shared_state.version + 1, updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(semNfKey(orderId), JSON.stringify(noInvoice))
      .run();
    return jsonResponse({ noInvoice });
  } catch (error) {
    console.error("Não foi possível marcar o pedido como sem NF.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MARCAR O PEDIDO COMO SEM NF." }, 500);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const checked = await guard(request, context);
  if ("error" in checked) return checked.error;
  const { orderId, database } = checked;
  try {
    await database.prepare("DELETE FROM shared_state WHERE state_key=?1").bind(semNfKey(orderId)).run();
    return jsonResponse({ noInvoice: null, status: "VOLTOU A EXIGIR NF" });
  } catch (error) {
    console.error("Não foi possível desmarcar o pedido sem NF.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ALTERAR O PEDIDO." }, 500);
  }
}
