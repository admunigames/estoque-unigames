// Backfill pontual: vincula em supplier_invoice_attachments o anexo de NF
// ('nota_fiscal') já enviado no pedido de Compras (purchase_order_attachments)
// para NFs do Financeiro que foram criadas/vinculadas ANTES da correção do
// handoff e por isso ficaram sem anexo ("Nenhum anexo."). Reaproveita a
// MESMA r2_key (mesmo bucket R2) — não duplica o arquivo físico.
//
// Idempotente: só insere quando ainda não existe nenhuma linha de anexo
// para a NF com aquela r2_key (mesma checagem do handoff).
//
// Uso:
//   SUPABASE_DB_URL="postgresql://..." node db/scripts/backfill-invoices-missing-po-attachment.mjs

import postgres from "postgres";
import { randomUUID } from "node:crypto";

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }
  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require" });

  try {
    const candidates = await sql.unsafe(`
      SELECT
        si.id AS "invoiceId",
        si.invoice_number AS "invoiceNumber",
        poa.r2_key AS "r2Key",
        poa.file_name AS "fileName",
        poa.content_type AS "contentType",
        poa.size_bytes AS "sizeBytes",
        poa.uploaded_by AS "uploadedBy",
        poa.uploaded_by_name AS "uploadedByName"
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

    if (candidates.length === 0) {
      console.log("Nenhuma NF pendente de backfill.");
      return;
    }

    for (const row of candidates) {
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO supplier_invoice_attachments
            (id, invoice_id, installment_id, payment_id, attachment_type, r2_key, file_name, content_type,
             size_bytes, uploaded_by, uploaded_by_name, created_at)
           VALUES ($1,$2,'','','nf',$3,$4,$5,$6,$7,$8,now()::text)`,
          [
            randomUUID(),
            row.invoiceId,
            row.r2Key,
            row.fileName,
            row.contentType,
            row.sizeBytes,
            row.uploadedBy,
            row.uploadedByName,
          ],
        );
        await tx.unsafe(
          `INSERT INTO supplier_invoice_events
            (id, invoice_id, event_type, description, metadata_json, actor_id, actor_name, created_at)
           VALUES ($1,$2,'attachment_added',$3,'{}','system','Correção retroativa',now()::text)`,
          [randomUUID(), row.invoiceId, `ANEXO DA NF VINCULADO RETROATIVAMENTE A PARTIR DO PEDIDO DE COMPRAS (${row.fileName}).`],
        );
      });
      console.log(`OK — NF ${row.invoiceNumber} (invoice_id=${row.invoiceId}): anexo "${row.fileName}" vinculado.`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
