-- Avaliação Operacional (11/11/2026): situações (erros/ocorrências) por
-- unidade, com data, descrição, quem cometeu e peso 1–5. O total do mês é a soma dos pesos;
-- a menor pontuação é a LOJA PREMIUM. A lista de unidades fica no código
-- (app/api/avaliacao-operacional/route.ts). Excluir = deleted=1.
-- Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "ops_evaluations" (
  "id" text PRIMARY KEY NOT NULL,
  "unit" text NOT NULL,
  "event_date" text NOT NULL,
  "description" text NOT NULL,
  "responsible" text DEFAULT '' NOT NULL,
  "weight" integer NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_evaluations_month_idx" ON "ops_evaluations" ("deleted", "event_date");
