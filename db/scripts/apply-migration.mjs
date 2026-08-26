// Aplica um único arquivo de migration .sql direto no Supabase, sem passar
// pelo drizzle-kit (cujo tracking `__drizzle_migrations` está dessincronizado
// neste projeto — ver estoque_modulo_aparelhos_emprestimo). Divide o arquivo
// por `--> statement-breakpoint` e roda cada statement numa transação.
//
// Uso:
//   SUPABASE_DB_URL="postgresql://..." node db/scripts/apply-migration.mjs drizzle/0033_finance_cost_centers.sql

import fs from "node:fs";
import postgres from "postgres";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Uso: node apply-migration.mjs <arquivo.sql>");
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Aplicando ${filePath} (${statements.length} statements)...`);

  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
  try {
    await sql.begin(async (tx) => {
      for (const [index, statement] of statements.entries()) {
        console.log(`[${index + 1}/${statements.length}] ${statement.slice(0, 80).replace(/\s+/g, " ")}...`);
        await tx.unsafe(statement);
      }
    });
    console.log("Migration aplicada com sucesso.");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("Falha ao aplicar migration:", error.message);
  process.exit(1);
});
