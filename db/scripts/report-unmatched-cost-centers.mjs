// Lista valores de cost_center (texto livre) em accounts_payable/expenses/
// supplier_invoices que NÃO bateram com nenhum item do cadastro novo
// finance_cost_centers após a migration 0033 (cost_center_id continua NULL).
// Rodar depois de aplicar a 0033, antes de decidir o que fazer com esses
// lançamentos (mapear manualmente, criar novo item no cadastro, ou deixar
// sem centro de custo).
//
// Uso:
//   SUPABASE_DB_URL="postgresql://..." node db/scripts/report-unmatched-cost-centers.mjs

import postgres from "postgres";

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }
  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require" });

  const tables = [
    { name: "accounts_payable", label: "Contas a Pagar" },
    { name: "expenses", label: "Despesas" },
    { name: "supplier_invoices", label: "Notas Fiscais" },
  ];

  try {
    for (const table of tables) {
      const rows = await sql.unsafe(
        `SELECT cost_center AS "costCenter", COUNT(*) AS total
         FROM ${table.name}
         WHERE cost_center_id IS NULL AND cost_center <> ''
         GROUP BY cost_center
         ORDER BY total DESC`,
      );
      console.log(`\n=== ${table.label} (${table.name}) ===`);
      if (rows.length === 0) {
        console.log("  (nenhum valor sem correspondência)");
      } else {
        for (const row of rows) {
          console.log(`  "${row.costCenter}" — ${row.total} registro(s)`);
        }
      }
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
