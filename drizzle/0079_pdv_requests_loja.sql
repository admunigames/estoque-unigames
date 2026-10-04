-- Alterações PDV passam a guardar a loja da solicitação (escopo por loja:
-- login com loja vinculada só vê/age nas da própria loja — app/lib/access-scope.ts).
ALTER TABLE "pdv_change_requests" ADD COLUMN IF NOT EXISTS "company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pdv_change_requests" ADD COLUMN IF NOT EXISTS "company_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pdv_change_requests_company_status_created_idx" ON "pdv_change_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
-- Backfill: loja do LOGIN de quem criou. Quem foi criado por login sem loja
-- (ou login já removido) fica com company_id vazio — visível só para quem
-- vê todas as lojas.
UPDATE "pdv_change_requests" AS r
SET "company_id" = u."company_id"
FROM "app_users" AS u
WHERE u."id" = r."created_by" AND r."company_id" = '' AND u."company_id" <> '';--> statement-breakpoint
UPDATE "pdv_change_requests" AS r
SET "company_name" = c->>'name'
FROM "shared_state" AS s, jsonb_array_elements(s."value_json"::jsonb) AS c
WHERE s."state_key" = 'companies_list' AND c->>'id' = r."company_id"
  AND r."company_id" <> '' AND r."company_name" = '';
