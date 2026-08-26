CREATE TABLE "finance_cost_centers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts_payable" ADD COLUMN "cost_center_id" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "cost_center_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "cost_center_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_cost_centers_name_idx" ON "finance_cost_centers" USING btree ("name");
--> statement-breakpoint
INSERT INTO "finance_cost_centers" ("id", "name", "position", "created_by", "created_by_name") VALUES
	('06bc2440-457a-4b56-8737-dfab2700e705', 'Comercial', 0, 'system', 'Sistema'),
	('e2c813a8-dd63-4753-a904-eb5bf404773e', 'Administrativo', 1, 'system', 'Sistema'),
	('d288e249-43e1-4b8c-979e-bd499981793e', 'RH', 2, 'system', 'Sistema'),
	('e901c8d8-4882-43c8-a589-f011911777ee', 'Financeiro', 3, 'system', 'Sistema'),
	('c7602918-ac39-4e36-a0f3-be4deae79bd2', 'Marketing', 4, 'system', 'Sistema'),
	('4bdc0e47-72b6-4317-813a-566090aecb92', 'Assistência', 5, 'system', 'Sistema'),
	('2f6cdc9c-734a-4fd1-b44a-f46b3c9a123c', 'Logística', 6, 'system', 'Sistema'),
	('a65145e3-a294-4e5f-af76-97f8bc9a76e6', 'TI', 7, 'system', 'Sistema'),
	('d69d77ae-abd0-4da3-865c-de0e17044114', 'Diretoria', 8, 'system', 'Sistema'),
	('9707abe1-80f8-4276-ad3b-76dfe449284e', 'Outros', 9, 'system', 'Sistema');
--> statement-breakpoint
-- Backfill: liga os lançamentos que já têm centro de custo em texto livre ao
-- cadastro novo, casando por nome (sem diferenciar maiúsculas/acentos/espaços
-- nas pontas). Valores que não baterem com nenhum item ficam com
-- cost_center_id NULL e continuam com o texto antigo preservado em
-- cost_center — não são apagados nem forçados a "Outros" automaticamente,
-- pois isso exigiria decisão de quem lançou o dado.
UPDATE "accounts_payable" ap SET "cost_center_id" = fcc.id
FROM "finance_cost_centers" fcc
WHERE ap."cost_center_id" IS NULL
	AND ap."cost_center" <> ''
	AND lower(trim(ap."cost_center")) = lower(fcc."name");
--> statement-breakpoint
UPDATE "expenses" e SET "cost_center_id" = fcc.id
FROM "finance_cost_centers" fcc
WHERE e."cost_center_id" IS NULL
	AND e."cost_center" <> ''
	AND lower(trim(e."cost_center")) = lower(fcc."name");
--> statement-breakpoint
UPDATE "supplier_invoices" si SET "cost_center_id" = fcc.id
FROM "finance_cost_centers" fcc
WHERE si."cost_center_id" IS NULL
	AND si."cost_center" <> ''
	AND lower(trim(si."cost_center")) = lower(fcc."name");