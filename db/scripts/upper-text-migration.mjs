// Converte para CAIXA ALTA o texto livre JÁ GRAVADO (padronização de
// 18/10/2026). Mesma lista que o servidor usa ao gravar
// (UPPER_TEXT_COLUMNS em app/lib/upper-text.ts) + nomes/textos dos cadastros
// em JSON do shared_state (lojas e tarefas). Login, senha, e-mail, PIX, ids,
// status, arquivos e dados importados ficam fora da lista.
//
// 1) BACKUP antes de tudo:
//      pg_dump "$SUPABASE_DB_URL" -Fc -f backup-antes-caixa-alta.dump
// 2) Simulação (só lê, não grava nada) — linhas por tabela/coluna e
//    duplicidades que a conversão criaria em índices únicos:
//      SUPABASE_DB_URL="postgresql://..." node --experimental-strip-types db/scripts/upper-text-migration.mjs
// 3) Com o OK do responsável, aplica (uma transação por tabela) e registra
//    na Auditoria:
//      SUPABASE_DB_URL="postgresql://..." node --experimental-strip-types db/scripts/upper-text-migration.mjs --aplicar

import postgres from "postgres";
import { UPPER_JSON_STATE_KEY, UPPER_TEXT_COLUMNS, upperJsonFields } from "../../app/lib/upper-text.ts";

const apply = process.argv.includes("--aplicar");
const ident = (name) => `"${name.replace(/"/g, '""')}"`;

async function existingColumns(sql, table, columns) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND data_type = 'text'`;
  const present = new Set(rows.map((row) => row.column_name));
  return columns.filter((column) => present.has(column));
}

// Índices únicos que envolvem colunas convertidas: conta grupos que passariam
// a colidir (ex.: "Riomar" e "RIOMAR" na mesma tabela).
async function uniqueCollisions(sql, table, columns) {
  const indexes = await sql`
    SELECT i.indexrelid::regclass::text AS name, array_agg(a.attname::text ORDER BY k.ord) AS cols
    FROM pg_index i
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indisunique AND i.indrelid = ${`public.${table}`}::regclass
    GROUP BY i.indexrelid`;
  const out = [];
  for (const index of indexes) {
    if (!index.cols.some((column) => columns.includes(column))) continue;
    const exprs = index.cols.map((column) => (columns.includes(column) ? `upper(${ident(column)})` : ident(column)));
    const [{ count }] = await sql.unsafe(
      `SELECT count(*)::int AS count FROM (SELECT 1 FROM ${ident(table)} GROUP BY ${exprs.join(", ")} HAVING count(*) > 1) AS d`,
    );
    if (count) out.push(`${index.name}: ${count} grupo(s) duplicado(s)`);
  }
  return out;
}

async function main() {
  if (!process.env.SUPABASE_DB_URL) throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
  console.log(apply ? "APLICANDO conversão para CAIXA ALTA..." : "SIMULAÇÃO (nada será gravado)...");
  const report = [];
  const blockers = [];
  try {
    for (const [table, listed] of Object.entries(UPPER_TEXT_COLUMNS)) {
      const columns = await existingColumns(sql, table, listed);
      const missing = listed.filter((column) => !columns.includes(column));
      if (missing.length) console.log(`  (aviso) ${table}: colunas não encontradas no banco: ${missing.join(", ")}`);
      if (!columns.length) continue;

      const counts = await sql.unsafe(
        `SELECT ${columns.map((c) => `count(*) FILTER (WHERE ${ident(c)} <> upper(${ident(c)}))::int AS ${ident(c)}`).join(", ")} FROM ${ident(table)}`,
      );
      const changed = Object.entries(counts[0]).filter(([, count]) => count > 0);
      if (!changed.length) continue;
      const collisions = await uniqueCollisions(sql, table, columns);
      if (collisions.length) blockers.push(`${table} → ${collisions.join("; ")}`);
      for (const [column, count] of changed) report.push({ table, column, rows: count });
      console.log(`  ${table}: ${changed.map(([c, n]) => `${c}=${n}`).join(", ")}${collisions.length ? `  ⚠ ${collisions.join("; ")}` : ""}`);

      if (apply && !collisions.length) {
        const cols = changed.map(([column]) => column);
        const result = await sql.begin((tx) =>
          tx.unsafe(
            `UPDATE ${ident(table)} SET ${cols.map((c) => `${ident(c)} = upper(${ident(c)})`).join(", ")}
             WHERE ${cols.map((c) => `${ident(c)} <> upper(${ident(c)})`).join(" OR ")}`,
          ),
        );
        console.log(`    ✔ ${result.count} linha(s) atualizada(s)`);
      }
    }

    // Cadastros em JSON (lojas, tarefas): só name/legalName/address/text.
    const states = await sql`SELECT state_key, value_json FROM shared_state WHERE state_key = 'companies_list' OR state_key LIKE 'tarefas:%'`;
    let stateRows = 0;
    for (const row of states) {
      if (!UPPER_JSON_STATE_KEY.test(row.state_key)) continue;
      let next;
      try {
        next = JSON.stringify(upperJsonFields(JSON.parse(row.value_json)));
      } catch {
        continue;
      }
      if (next === JSON.stringify(JSON.parse(row.value_json))) continue;
      stateRows++;
      if (apply) {
        await sql.begin((tx) => tx`
          UPDATE shared_state SET value_json = ${next}, version = version + 1, updated_at = now()::text
          WHERE state_key = ${row.state_key} AND value_json = ${row.value_json}`);
      }
    }
    report.push({ table: "shared_state", column: "value_json (lojas/tarefas)", rows: stateRows });
    console.log(`  shared_state (lojas/tarefas): ${stateRows}`);

    const total = report.reduce((sum, item) => sum + item.rows, 0);
    console.log(`\nTOTAL: ${total} valor(es) em ${new Set(report.map((r) => r.table)).size} tabela(s).`);
    if (blockers.length) {
      console.log(`\n⚠ ${blockers.length} tabela(s) com duplicidade por caixa — ${apply ? "NÃO foram convertidas" : "seriam puladas"}; resolver à mão:`);
      for (const line of blockers) console.log(`  - ${line}`);
    }

    if (apply) {
      await sql`
        INSERT INTO audit_log (id, at, user_id, user_name, company_id, method, path, module, action, record_id, summary, status)
        VALUES (${crypto.randomUUID()}, ${new Date().toISOString()}, 'script', 'MIGRAÇÃO CAIXA ALTA', '', 'SCRIPT',
                'db/scripts/upper-text-migration.mjs', 'CADASTROS', 'EDITOU', '',
                ${`TEXTO LIVRE CONVERTIDO PARA CAIXA ALTA: ${total} VALOR(ES)${blockers.length ? `; ${blockers.length} TABELA(S) PULADA(S) POR DUPLICIDADE` : ""}.`},
                200)`;
      console.log("Registrado na Auditoria.");
    } else {
      console.log("\nNada foi gravado. Para aplicar: rode de novo com --aplicar (depois do backup e do OK).");
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("Falha:", error.message);
  process.exit(1);
});
