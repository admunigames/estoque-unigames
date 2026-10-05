-- Assistência: categoria ELETRÔNICOS para o HOVERBOARD (estava em CONSOLES)
-- e PREVENTIVA do hoverboard no mesmo padrão do PS3 SLIM (R$ 150,00, entra
-- como desconto quando há outro serviço no equipamento).
UPDATE "assist_defects" SET "category" = 'ELETRÔNICOS' WHERE "device" = 'HOVERBOARD';--> statement-breakpoint
UPDATE "assist_quote_items" SET "category" = 'ELETRÔNICOS' WHERE "device" = 'HOVERBOARD';--> statement-breakpoint
INSERT INTO "assist_defects" ("id", "category", "device", "name", "min_cents", "max_cents", "quote_only", "sort_order") VALUES
	('assist-seed-234', 'ELETRÔNICOS', 'HOVERBOARD', 'PREVENTIVA', 15000, 15000, 0, 151)
ON CONFLICT ("device", "name") DO NOTHING;
