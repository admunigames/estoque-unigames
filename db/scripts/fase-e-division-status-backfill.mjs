// Fase E, item 3: pedidos NATIVOS já existentes com divisionStatus='' viram
// 'FALTA DIVISÃO' (mesmo default que a Fase E passa a aplicar a partir de
// agora na conversão de rascunho). Só toca origin='native' com o campo
// vazio — não mexe em pedidos importados do Notion nem em pedidos que já
// têm um status de divisão definido.
//
// Uso: node db/scripts/fase-e-division-status-backfill.mjs

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env) && value) process.env[key] = value;
  }
}

async function main() {
  loadEnvFile();
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }
  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
  try {
    const before = await sql`
      SELECT count(*)::int AS count FROM purchase_orders
      WHERE origin = 'native' AND division_status = ''
    `;
    console.log(`Pedidos nativos com divisionStatus vazio (antes): ${before[0].count}`);
    const updated = await sql`
      UPDATE purchase_orders
      SET division_status = 'FALTA DIVISÃO'
      WHERE origin = 'native' AND division_status = ''
      RETURNING id
    `;
    console.log(`Linhas atualizadas: ${updated.length}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("Falha ao rodar o backfill:", error.message);
  process.exit(1);
});
