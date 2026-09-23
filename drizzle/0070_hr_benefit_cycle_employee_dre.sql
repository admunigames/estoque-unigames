-- RH Financeiro — evolução de Benefícios (ciclo 20→19 + geração automática)
-- e DRE Funcionário (fechamento mensal por loja/colaborador).
--
-- Benefícios: valores PADRÃO por dia trabalhado ficam no próprio cadastro
-- do funcionário (hr_employees) — a geração do ciclo multiplica pelos dias
-- trabalhados de 20 do mês da competência a 19 do mês seguinte. O
-- lançamento gerado continua sendo um hr_benefits normal (Folha, DRE e
-- Fluxo de Caixa já o leem); `origin = 'ciclo'` só marca o que veio da
-- geração, para não gerar duas vezes o mesmo funcionário/competência.
--
-- DRE Funcionário: só o que não existia em nenhum módulo ganha tabela —
-- rescisões (valor + FGTS) e exames ASO fora do Recrutamento (periódico,
-- demissional…). Treinamento e aniversariantes são lidos direto de
-- hr_recruitment_test_payments e hr_employees.birth_date. O ASO admissional
-- continua no candidato do Recrutamento, que ganha data e CNPJ da clínica.
-- Sem FK real (convenção do projeto).
ALTER TABLE "hr_employees" ADD COLUMN "food_per_day_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN "transport_per_day_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN "benefit_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_benefits" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_benefits_cycle_employee_month_idx" ON "hr_benefits" USING btree ("employee_id","month") WHERE origin = 'ciclo';--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN "aso_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN "aso_clinic_cnpj" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE "hr_terminations" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"termination_date" text NOT NULL,
	"severance_cents" integer DEFAULT 0 NOT NULL,
	"fgts_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_terminations_date_idx" ON "hr_terminations" USING btree ("termination_date");--> statement-breakpoint
CREATE INDEX "hr_terminations_employee_idx" ON "hr_terminations" USING btree ("employee_id");--> statement-breakpoint
CREATE TABLE "hr_aso_exams" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"exam_type" text DEFAULT 'periodico' NOT NULL,
	"exam_date" text NOT NULL,
	"clinic_name" text DEFAULT '' NOT NULL,
	"clinic_cnpj" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_aso_exams_date_idx" ON "hr_aso_exams" USING btree ("exam_date");--> statement-breakpoint
CREATE INDEX "hr_aso_exams_employee_idx" ON "hr_aso_exams" USING btree ("employee_id");--> statement-breakpoint
ALTER TABLE "hr_terminations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_terminations" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "hr_aso_exams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_aso_exams" FROM anon, authenticated;
