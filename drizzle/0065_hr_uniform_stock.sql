CREATE TABLE "uniform_stock_items" (
	"id" text PRIMARY KEY NOT NULL,
	"piece_type" text NOT NULL,
	"size" text NOT NULL,
	"stock_qty" integer DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uniform_stock_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"movement_type" text NOT NULL,
	"piece_type" text NOT NULL,
	"size" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"employee_id" text DEFAULT '' NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"movement_date" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uniform_coat_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"movement_id" text NOT NULL,
	"employee_id" text DEFAULT '' NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'aguardando_assinatura' NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"r2_key" text DEFAULT '' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "uniform_stock_movements_piece_idx" ON "uniform_stock_movements" USING btree ("piece_type","size");--> statement-breakpoint
CREATE INDEX "uniform_stock_movements_employee_idx" ON "uniform_stock_movements" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "uniform_stock_movements_date_idx" ON "uniform_stock_movements" USING btree ("movement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uniform_coat_terms_movement_idx" ON "uniform_coat_terms" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "uniform_coat_terms_status_idx" ON "uniform_coat_terms" USING btree ("status");--> statement-breakpoint
ALTER TABLE "uniform_stock_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "uniform_stock_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "uniform_coat_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "uniform_stock_items" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "uniform_stock_movements" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "uniform_coat_terms" FROM anon, authenticated;--> statement-breakpoint
INSERT INTO "uniform_stock_items" ("id", "piece_type", "size", "stock_qty")
SELECT piece_type || ':' || size, piece_type, size, 0
FROM (VALUES ('unitec'), ('unigames'), ('pa'), ('lider'), ('adm'), ('casacos')) AS pieces(piece_type)
CROSS JOIN (VALUES ('P'), ('M'), ('G'), ('GG'), ('XGG'), ('XXGG')) AS sizes(size)
ON CONFLICT ("id") DO NOTHING;
