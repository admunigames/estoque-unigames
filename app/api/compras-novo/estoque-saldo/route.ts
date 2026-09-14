import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyList } from "../../finance/shared";
import { normalizeProductKey } from "../../product-catalog/shared";
import { canManageComprasDraft, identity, jsonResponse } from "../shared";

type StateRow = { stateKey: string; value: string };
type CatalogMatchRow = { name: string; codeUnigames: string; codePa: string };

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

// Soma um mapa entrada/saída (chaveado pelo código QUE AQUELA LOJA usa —
// pode ser tanto o código Unigames quanto o P.A Loja, sistemas diferentes
// numerando o mesmo produto de forma diferente) casando por QUALQUER
// código conhecido do catálogo geral (matchCodes) OU pelo nome normalizado
// (matchNameKey) quando a chave não bate com nenhum código mas o "nome"
// gravado junto da quantidade é o mesmo produto — sem isso, o saldo somado
// aqui perdia lojas que registraram o produto com o código do outro
// sistema (bug relatado: saldo batendo só com o código de uma das lojas).
function sumMatchingQuantity(
  bucket: Record<string, unknown> | undefined,
  matchCodes: Set<string>,
  matchNameKey: string,
): { qtd: number; nome: string } {
  if (!bucket) return { qtd: 0, nome: "" };
  let qtd = 0;
  let nome = "";
  for (const [key, rawValue] of Object.entries(bucket)) {
    const value = extractQuantity(rawValue);
    const nameKey = value.nome ? normalizeProductKey(value.nome) : "";
    if (matchCodes.has(key) || (matchNameKey && nameKey && nameKey === matchNameKey)) {
      qtd += value.qtd;
      nome = nome || value.nome;
    }
  }
  return { qtd, nome };
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
    // Resolve o produto no catálogo geral (por qualquer código OU pelo nome
    // exato) pra descobrir os DOIS códigos possíveis (Unigames/P.A Loja) —
    // "produto" pode ter chegado como qualquer um dos dois, ou como o nome.
    const [catalogMatch, rows, companies] = await Promise.all([
      database
        .prepare(
          `SELECT name, code_unigames AS codeUnigames, code_pa AS codePa
           FROM product_catalog WHERE code_unigames=?1 OR code_pa=?1 OR name=?1 LIMIT 1`,
        )
        .bind(produto)
        .first<CatalogMatchRow>(),
      database
        .prepare("SELECT state_key AS stateKey, value_json AS value FROM shared_state WHERE state_key LIKE 'estoque:c%'")
        .all<StateRow>(),
      loadCompanyList(database),
    ]);
    const companyNameById = new Map(companies.map((company) => [company.id, company.name]));

    const matchCodes = new Set(
      [produto, catalogMatch?.codeUnigames, catalogMatch?.codePa].filter((code): code is string => Boolean(code)),
    );
    const matchNameKey = normalizeProductKey(catalogMatch?.name || produto);

    const balances = (rows.results ?? [])
      .map((row) => {
        const companyId = row.stateKey.slice("estoque:".length);
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(row.value) as Record<string, unknown>;
        } catch {
          data = {};
        }
        const entrada = sumMatchingQuantity(data.entrada as Record<string, unknown> | undefined, matchCodes, matchNameKey);
        const saida = sumMatchingQuantity(data.saida as Record<string, unknown> | undefined, matchCodes, matchNameKey);
        const produtoNome = catalogMatch?.name || entrada.nome || saida.nome || "";
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
