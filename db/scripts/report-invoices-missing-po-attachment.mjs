// Lista NFs do Financeiro (supplier_invoices) vinculadas a um pedido nativo
// de Compras (purchase_order_id preenchido) cujo pedido TEM um anexo de NF
// (purchase_order_attachments, attachment_type='nota_fiscal') mas que ainda
// não têm nenhuma linha em supplier_invoice_attachments — exatamente o
// sintoma "Nenhum anexo." causado pelo handoff que não copiava a referência.
// Somente leitura — não altera nada. Rodar antes de decidir um backfill
// retroativo.
//
// Uso:
//   SUPABASE_DB_URL="postgresql://..." node db/scripts/report-invoices-missing-po-attachment.mjs

import postgres from "postgres";

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }
  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require" });

  try {
    const rows = await sql.unsafe(`
      SELECT
        si.id AS "invoiceId",
        si.invoice_number AS "invoiceNumber",
        si.company_name AS "companyName",
        si.purchase_order_id AS "purchaseOrderId",
        si.created_at AS "createdAt",
        poa.id AS "orderAttachmentId",
        poa.file_name AS "fileName"
      FROM supplier_invoices si
      JOIN purchase_order_attachments poa
        ON poa.order_id = si.purchase_order_id
        AND poa.attachment_type = 'nota_fiscal'
      WHERE si.purchase_order_id <> ''
        AND NOT EXISTS (
          SELECT 1 FROM supplier_invoice_attachments sia WHERE sia.invoice_id = si.id
        )
      ORDER BY si.created_at DESC
    `);

    if (rows.length === 0) {
      console.log("Nenhuma NF encontrada nessa condição — nada para corrigir retroativamente.");
      return;
    }

    console.log(`${rows.length} NF(s) do Financeiro sem anexo, com anexo disponível no pedido de Compras:\n`);
    for (const row of rows) {
      console.log(
        `- NF ${row.invoiceNumber} (${row.companyName}) — invoice_id=${row.invoiceId}, ` +
          `purchase_order_id=${row.purchaseOrderId}, anexo do pedido="${row.fileName}", criada em ${row.createdAt}`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
