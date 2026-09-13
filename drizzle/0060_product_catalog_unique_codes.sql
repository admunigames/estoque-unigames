DROP INDEX "product_catalog_code_unigames_idx";--> statement-breakpoint
DROP INDEX "product_catalog_code_pa_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "product_catalog_code_unigames_idx" ON "product_catalog" USING btree ("code_unigames") WHERE code_unigames <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "product_catalog_code_pa_idx" ON "product_catalog" USING btree ("code_pa") WHERE code_pa <> '';
