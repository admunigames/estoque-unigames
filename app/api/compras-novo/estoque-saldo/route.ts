import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import { canManageComprasDraft, identity, jsonResponse } from "../shared";

type StateRow = { stateKey: string; value: string };

// Mesma leitura que o cliente já fazia varrendo shared_state chave a chave
// (ver loadFiscalView/addFiscalQuantities em public/estoque.html) — só que
// agora agregada no servidor com uma única query, pra popular a sugestão de
// reposição sem o cliente ter de buscar N chaves na tela de Compras.
function extractQuantity(rawValue: unknown): { qtd: number; nome: string } {
  if (rawValue && typeof rawValue === "object") {
    const record = rawValue as Record<string, unknown>;
    return { qtd: Number(record.qtd) || 0, nome: typeof record.nome === "string" ? record.nome : "" };
  }
  return { qtd: Number(rawValue) || 0, nome: "" };
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  const url = new URL(request.url);
  const produto = (url.searchParams.get("produto") || "").trim();
  if (!produto) return jsonResponse({ error: "INFORME O CÓDIGO DO PRODUTO." }, 400);

  try {
    const database = await getD1();
    const [rows, companies] = await Promise.all([
      database
        .prepare("SELECT state_key AS stateKey, value_json AS value FROM shared_state WHERE state_key LIKE 'estoque:c%'")
        .all<StateRow>(),
      loadCompanyList(database),
    ]);
    const companyNameById = new Map(companies.map((company) => [company.id, company.name]));

    const balances = (rows.results ?? [])
      .map((row) => {
        const companyId = row.stateKey.slice("estoque:".length);
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(row.value) as Record<string, unknown>;
        } catch {
          data = {};
        }
        const entrada = extractQuantity((data.entrada as Record<string, unknown> | undefined)?.[produto]);
        const saida = extractQuantity((data.saida as Record<string, unknown> | undefined)?.[produto]);
        const produtoNome = entrada.nome || saida.nome || "";
        return {
          companyId,
          companyName: companyNameById.get(companyId) || companyId,
          produtoNome,
          saldo: entrada.qtd - saida.qtd,
        };
      })
      // Só entram lojas onde o produto realmente aparece no estoque fiscal
      // (entrada ou saída registrada) — evita listar todas as lojas com
      // saldo zero por não terem nenhum lançamento desse código.
      .filter((row) => row.produtoNome || row.saldo !== 0)
      .sort((a, b) => a.saldo - b.saldo);

    return jsonResponse({ produto, balances });
  } catch (error) {
    console.error("Não foi possível calcular o saldo do produto.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CALCULAR O SALDO." }, 500);
  }
}
