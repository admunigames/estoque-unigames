// Script único de exportação/importação: copia os dados do D1 remoto
// (produção Cloudflare) para o Supabase (Postgres).
//
// NÃO roda automaticamente em nenhum pipeline — é disparado manualmente,
// só quando a migração dos módulos estiver validada e for hora do corte
// (ver plano de Fase 2). É seguro rodar mais de uma vez: usa
// `ON CONFLICT (pk) DO NOTHING`, então linhas já copiadas são ignoradas.
//
// Pré-requisitos:
//   - Autenticado no wrangler (`wrangler login`) ou com
//     CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID no ambiente, com acesso
//     ao banco D1 "estoque-unigames-db" (produção).
//   - SUPABASE_DB_URL setada, apontando para o Supabase de destino
//     (recomendado: usar a connection string DIRETA, porta 5432, para uma
//     carga em lote única — não o transaction pooler usado em runtime).
//
// Uso:
//   SUPABASE_DB_URL="postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres" \
//     node db/scripts/migrate-d1-to-supabase.mjs [--dry-run] [--table=nome]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const wranglerBin = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.CMD" : "wrangler",
);

const D1_DATABASE_NAME = "estoque-unigames-db";

// Ordem não importa para integridade referencial (não há FKs declaradas no
// D1 atual), mas mantém uma ordem estável e legível para o log.
const TABLES = [
  "app_users",
  "password_reset_requests",
  "user_preferences",
  "push_subscriptions",
  "push_delivery_log",
  "shared_state",
  "missions",
  "mission_completions",
  "instructions",
  "captured_products",
  "defective_outputs",
  "supply_items",
  "supply_request_events",
  "purchase_delivery_records",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyTable = args.find((arg) => arg.startsWith("--table="))?.split("=")[1];

async function fetchD1Rows(table) {
  const { stdout } = await execFileAsync(wranglerBin, [
    "d1",
    "execute",
    D1_DATABASE_NAME,
    "--remote",
    "--json",
    "--command",
    `SELECT * FROM ${table}`,
  ]);
  const parsed = JSON.parse(stdout);
  // `wrangler d1 execute --json` retorna um array de resultados de query.
  const [firstResult] = parsed;
  return firstResult?.results ?? [];
}

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }

  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require" });

  try {
    const tables = onlyTable ? [onlyTable] : TABLES;

    for (const table of tables) {
      process.stdout.write(`\n[${table}] lendo do D1 (remoto)...\n`);
      const rows = await fetchD1Rows(table);
      process.stdout.write(`[${table}] ${rows.length} linha(s) encontradas.\n`);

      if (!rows.length) continue;
      if (dryRun) {
        process.stdout.write(`[${table}] --dry-run: nada foi escrito no Supabase.\n`);
        continue;
      }

      const columns = Object.keys(rows[0]);
      const BATCH_SIZE = 500;
      let inserted = 0;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await sql`
          INSERT INTO ${sql(table)} ${sql(batch, ...columns)}
          ON CONFLICT DO NOTHING
        `;
        inserted += batch.length;
        process.stdout.write(`[${table}] ${inserted}/${rows.length} copiadas...\n`);
      }
    }

    process.stdout.write("\nMigração de dados concluída.\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("Falha na migração de dados D1 -> Supabase:", error);
  process.exitCode = 1;
});
