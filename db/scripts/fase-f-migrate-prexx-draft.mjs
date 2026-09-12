// Script de uso único (Fase F do módulo Compras nativo): recria como um
// Pedido de Compra nativo (purchase_orders) o rascunho real "PREXX" que
// existia em purchase_drafts quando a Fase F fundiu Rascunho+Pedido — ver
// nota em drizzle/0059_compras_nativo_fase_f.sql. O rascunho não tinha
// nenhum item (confirmado antes de rodar), então não há purchase_draft_items
// pra migrar junto.
//
// Idempotente por conteúdo: não cria de novo se já existir um pedido nativo
// com esse nome/autor criado no mesmo dia (checagem simples, não crítica —
// é um script de uso único, não pensado pra rodar repetidamente).
//
// Uso:
//   SUPABASE_DB_URL="postgresql://..." node db/scripts/fase-f-migrate-prexx-draft.mjs

import postgres from "postgres";

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }
  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });

  try {
    const draft = await sql`SELECT * FROM purchase_drafts WHERE name = 'PREXX' LIMIT 1`;
    if (!draft.length) {
      console.log("Nenhum rascunho 'PREXX' encontrado — nada a fazer (já migrado ou removido).");
      return;
    }
    const row = draft[0];

    const itemCount = await sql`SELECT COUNT(*) FROM purchase_draft_items WHERE draft_id = ${row.id}`;
    if (Number(itemCount[0].count) > 0) {
      throw new Error(
        `O rascunho 'PREXX' tem ${itemCount[0].count} item(ns) — este script só migra o cabeçalho. Pare e migre os itens manualmente.`,
      );
    }

    const existing = await sql`
      SELECT id FROM purchase_orders
      WHERE origin = 'native' AND notes = 'PREXX' AND created_by = ${row.created_by}
      LIMIT 1
    `;
    if (existing.length) {
      console.log(`Já existe um pedido nativo 'PREXX' (id ${existing[0].id}) — nada a fazer.`);
      return;
    }

    const id = crypto.randomUUID();
    await sql`
      INSERT INTO purchase_orders (
        id, origin, notion_purchase_id, notion_purchase_url, supplier_id, supplier_name_raw,
        company_id, company_name, order_date, expected_date, received_date, division, division_status,
        status, no_items_detailed, notes, canceled, won_at, won_by, won_by_name,
        created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at
      ) VALUES (
        ${id}, 'native', '', '', '', '',
        '', '', '', '', '', '', '',
        'aberto', 0, 'PREXX', 0, '', '', '',
        ${row.created_by}, ${row.created_by_name}, ${row.created_at}, ${row.created_by}, ${row.created_by_name}, now()::text
      )
    `;
    console.log(`Pedido de compra nativo criado a partir do rascunho 'PREXX': id ${id} (autor: ${row.created_by_name}).`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("Falha ao migrar o rascunho 'PREXX'.", error);
  process.exit(1);
});
