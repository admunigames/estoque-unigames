-- NOTA: os DROP TABLE de purchase_draft_items/purchase_drafts foram
-- removidos deste arquivo por decisão do usuário — havia um rascunho real
-- ("PREXX", criado por RENATO em 2026-09-12) em produção quando essa
-- migration ia ser aplicada. As tabelas antigas ficam preservadas no banco
-- (não são mais referenciadas pelo código, que agora usa só purchase_orders/
-- purchase_order_items), e o rascunho foi recriado manualmente como um
-- Pedido de Compra nativo (ver db/scripts/fase-f-migrate-prexx-draft.mjs).
ALTER TABLE "purchase_orders" ADD COLUMN "won_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "won_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "won_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "candidate_supplier_ids" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE TABLE "purchase_order_item_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "purchase_order_item_quotes_item_idx" ON "purchase_order_item_quotes" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_item_quotes_item_supplier_idx" ON "purchase_order_item_quotes" USING btree ("item_id","supplier_id");--> statement-breakpoint
ALTER TABLE "purchase_order_item_quotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "purchase_order_item_quotes" FROM anon, authenticated;
