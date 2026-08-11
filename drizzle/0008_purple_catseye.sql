ALTER TABLE "supply_stock_movements" ADD COLUMN "company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_stock_movements" ADD COLUMN "company_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "supply_stock_movements_company_idx" ON "supply_stock_movements" USING btree ("company_id");