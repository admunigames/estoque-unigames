// Importa os pedidos do Controle de Compras (Notion) para a tabela nova
// purchase_orders (origin='notion_import'), preparando o terreno da Fase B
// do módulo "Compras" nativo. NÃO mexe no Notion nem no Controle de Compras
// atual (app/lib/notion.ts, app/api/compras/*) — só LÊ de lá.
//
// Reaproveita as MESMAS funções de paginação/normalização já usadas por
// app/api/compras/route.ts (notionRequest, notionDataSourceId,
// normalizePurchase) — evita duplicar a lógica de chamada à API do Notion.
//
// Dedupe: pula pedidos cujo notion_purchase_id (page.id) já existe em
// purchase_orders — pode rodar de novo sem duplicar (import incremental).
//
// Casamento de fornecedor: compara o texto de FORNECEDOR (Notion) com
// finance_suppliers.name, case-insensitive e após trim. Quando não bate com
// nada (nome novo ou só existem cadastros inativos), CRIA um finance_suppliers
// novo (ativo, sem document/CNPJ — fica para completar depois) a partir do
// nome cru do Notion, e vincula supplierId a ele. Isso popula o cadastro real
// a partir do histórico em vez de deixar todo pedido com supplierId vazio —
// decisão confirmada com o usuário após o dry-run mostrar 47 fornecedores
// distintos e o cadastro praticamente vazio em produção. Nomes iguais (após
// trim/lowercase) no próprio lote do Notion reaproveitam o mesmo fornecedor
// recém-criado (cache em memória), nunca duplicam dentro de uma mesma run.
//
// Mapeamento de STATUS (Notion -> purchase_orders.status):
//   "Não iniciado"  -> 'pendente'
//   "Em andamento"  -> 'em_andamento'
//   "Concluído"     -> 'concluido'
//   (qualquer outro valor, incluindo vazio) -> 'pendente'
//
// Uso (NÃO rode contra produção sem autorização explícita — ver PR da Fase
// A do módulo Compras nativo):
//   SUPABASE_DB_URL="postgresql://..." \
//   NOTION_TOKEN="secret_..." \
//   NOTION_DATA_SOURCE_ID="..." \
//   node db/scripts/import-notion-purchases.mjs [--limit=N] [--dry-run]

import postgres from "postgres";
import { normalizePurchase, notionDataSourceId, notionRequest } from "../../app/lib/notion.ts";

const STATUS_MAP = {
  "Não iniciado": "pendente",
  "Em andamento": "em_andamento",
  "Concluído": "concluido",
};

function mapStatus(rawStatus) {
  return STATUS_MAP[rawStatus] || "pendente";
}

function normalizeSupplierName(value) {
  return String(value || "").trim().toLowerCase();
}

// Erros de digitação confirmados no texto livre do Notion (mesmo fornecedor,
// nome diferente) — mesclados na hora de casar/criar em finance_suppliers
// pra não gerar cadastro duplicado. supplierNameRaw em purchase_orders
// continua guardando o texto original do Notion, só o nome usado pra
// achar/criar o fornecedor é que vira o canônico.
const SUPPLIER_NAME_ALIASES = new Map([
  ["igram micro", "INGRAM MICRO"],
  ["mercado livere - asus", "MERCADO LIVRE - ASUS"],
  ["kinsale (tribotek)", "TRIBOTEK"],
]);

function canonicalSupplierName(rawName) {
  const trimmed = String(rawName || "").trim();
  const alias = SUPPLIER_NAME_ALIASES.get(normalizeSupplierName(trimmed));
  return alias || trimmed;
}

async function fetchAllPurchases(limit) {
  const purchases = [];
  let cursor;
  do {
    const body = {
      page_size: 50,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const result = await notionRequest(`/data_sources/${notionDataSourceId()}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const pageItems = Array.isArray(result.results) ? result.results : [];
    for (const page of pageItems) {
      purchases.push(normalizePurchase(page));
      if (limit && purchases.length >= limit) return purchases;
    }
    cursor = result.next_cursor ?? undefined;
    if (!result.has_more) cursor = undefined;
  } while (cursor);
  return purchases;
}

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATA_SOURCE_ID) {
    throw new Error("Defina NOTION_TOKEN e NOTION_DATA_SOURCE_ID antes de rodar este script.");
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });

  let processed = 0;
  let imported = 0;
  let skippedExisting = 0;
  let unmatchedSupplier = 0;
  let suppliersCreated = 0;
  const createdSupplierNames = new Set();

  try {
    const suppliers = await sql`SELECT id, name FROM finance_suppliers WHERE active = 1`;
    const suppliersByName = new Map(suppliers.map((row) => [normalizeSupplierName(row.name), row.id]));

    console.log(dryRun ? "Modo --dry-run: nada será gravado." : "Importando pedidos do Notion...");
    const purchases = await fetchAllPurchases(limit);
    console.log(`${purchases.length} pedido(s) encontrado(s) no Notion.`);

    for (const purchase of purchases) {
      processed += 1;
      if (!purchase.id) continue;

      const existing = await sql`
        SELECT id FROM purchase_orders WHERE notion_purchase_id = ${purchase.id} LIMIT 1
      `;
      if (existing.length > 0) {
        skippedExisting += 1;
        continue;
      }

      const supplierNameRaw = String(purchase.fornecedor || "").trim();
      const supplierNameCanonical = canonicalSupplierName(supplierNameRaw);
      const normalizedSupplierName = normalizeSupplierName(supplierNameCanonical);
      let supplierId = normalizedSupplierName ? suppliersByName.get(normalizedSupplierName) || "" : "";

      if (!supplierId && normalizedSupplierName) {
        unmatchedSupplier += 1;
        if (dryRun) {
          createdSupplierNames.add(supplierNameCanonical);
        } else {
          supplierId = crypto.randomUUID();
          await sql`
            INSERT INTO finance_suppliers (
              id, name, document, notes, active,
              created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at
            ) VALUES (
              ${supplierId}, ${supplierNameCanonical}, '', 'Criado automaticamente a partir do histórico do Notion (import-notion-purchases).', 1,
              'import-notion-purchases', 'Importação Notion (script)', now()::text, '', '', now()::text
            )
          `;
          suppliersByName.set(normalizedSupplierName, supplierId);
          suppliersCreated += 1;
        }
      }

      if (dryRun) {
        imported += 1;
        continue;
      }

      const id = crypto.randomUUID();
      await sql`
        INSERT INTO purchase_orders (
          id, origin, notion_purchase_id, notion_purchase_url, supplier_id, supplier_name_raw,
          company_id, company_name, order_date, expected_date, received_date,
          division, division_status, status, no_items_detailed, notes,
          created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at
        ) VALUES (
          ${id}, 'notion_import', ${purchase.id}, ${purchase.url || ""}, ${supplierId}, ${supplierNameRaw},
          '', ${purchase.loja || ""}, ${purchase.dataPedido || ""}, ${purchase.previsao || ""}, ${purchase.dataRecebimento || ""},
          ${purchase.divisao || ""}, ${purchase.statusDivisao || ""}, ${mapStatus(purchase.status)}, 1, '',
          'import-notion-purchases', 'Importação Notion (script)', now()::text, '', '', now()::text
        )
      `;
      imported += 1;
    }
  } finally {
    await sql.end();
  }

  console.log("\n=== Resumo da importação ===");
  console.log(`Processados: ${processed}`);
  console.log(`Importados: ${imported}${dryRun ? " (simulado, --dry-run)" : ""}`);
  console.log(`Pulados (já existiam): ${skippedExisting}`);
  if (dryRun) {
    console.log(`Fornecedores que seriam criados em finance_suppliers: ${createdSupplierNames.size}`);
    for (const name of [...createdSupplierNames].sort()) console.log(`  - ${name}`);
  } else {
    console.log(`Fornecedores novos criados em finance_suppliers: ${suppliersCreated}`);
  }
  console.log(`Pedidos com fornecedor recém-criado (sem CNPJ/CPF, revisar depois): ${unmatchedSupplier}`);
}

main().catch((error) => {
  console.error("Falha ao importar pedidos do Notion:", error);
  process.exit(1);
});
