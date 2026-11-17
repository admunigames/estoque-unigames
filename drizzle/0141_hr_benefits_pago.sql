-- RH Financeiro > Benefícios (17/11/2026): status PAGO / A PAGAR por
-- lançamento, com quem marcou e quando. paid_at vazio = A PAGAR. Só
-- acrescenta colunas; todos os lançamentos existentes nascem A PAGAR (decisão
-- do usuário). Idempotente.
ALTER TABLE "hr_benefits" ADD COLUMN IF NOT EXISTS "paid_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_benefits" ADD COLUMN IF NOT EXISTS "paid_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_benefits" ADD COLUMN IF NOT EXISTS "paid_by_name" text DEFAULT '' NOT NULL;
