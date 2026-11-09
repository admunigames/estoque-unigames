-- COBRAR PREVENTIVA (09/11/2026): marca na linha da preventiva que ela é
-- cobrada mesmo com outro serviço no equipamento (sem o desconto automático).
ALTER TABLE "assist_quote_items" ADD COLUMN IF NOT EXISTS "charge_preventive" integer DEFAULT 0 NOT NULL;
