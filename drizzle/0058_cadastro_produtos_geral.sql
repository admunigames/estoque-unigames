CREATE TABLE "product_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code_unigames" text DEFAULT '' NOT NULL,
	"code_pa" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "product_catalog_code_unigames_idx" ON "product_catalog" USING btree ("code_unigames");--> statement-breakpoint
CREATE INDEX "product_catalog_code_pa_idx" ON "product_catalog" USING btree ("code_pa");--> statement-breakpoint
CREATE INDEX "product_catalog_name_idx" ON "product_catalog" USING btree ("name");--> statement-breakpoint
ALTER TABLE "product_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "product_catalog" FROM anon, authenticated;