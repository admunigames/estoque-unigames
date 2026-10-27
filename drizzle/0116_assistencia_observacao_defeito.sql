-- Assistência: OBSERVAÇÃO de cada defeito da tabela de valores (explica o que
-- o defeito significa). O orçamento guarda a cópia do texto na linha (como o
-- nome e o valor) e imprime embaixo do defeito no PDF.
ALTER TABLE "assist_defects" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_quote_items" ADD COLUMN "defect_note" text DEFAULT '' NOT NULL;
