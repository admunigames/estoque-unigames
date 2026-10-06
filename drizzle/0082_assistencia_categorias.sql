-- Assistência: aba CATEGORIAS (antes fixas no código) + categoria CELULAR/TABLET
-- e campo MODELO no equipamento do orçamento. asks_model = o orçamento mostra o
-- campo MODELO (celular/tablet, notebooks e computadores).
CREATE TABLE "assist_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"asks_model" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assist_categories_name_idx" ON "assist_categories" USING btree ("name");--> statement-breakpoint
ALTER TABLE "assist_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "assist_categories" FROM anon, authenticated;--> statement-breakpoint
INSERT INTO "assist_categories" ("id", "name", "asks_model", "sort_order") VALUES
	('assist-cat-consoles', 'CONSOLES', 0, 1),
	('assist-cat-controles', 'CONTROLES', 0, 2),
	('assist-cat-eletronicos', 'ELETRÔNICOS', 0, 3),
	('assist-cat-notebooks', 'NOTEBOOKS E COMPUTADORES', 1, 4),
	('assist-cat-celular-tablet', 'CELULAR/TABLET', 1, 5);--> statement-breakpoint
ALTER TABLE "assist_quote_items" ADD COLUMN "model" text DEFAULT '' NOT NULL;
