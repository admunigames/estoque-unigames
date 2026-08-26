-- RH Financeiro (Financeiro Fase 5) — Folha de Pagamento, Benefícios e
-- Comissionamento, apoiados num cadastro próprio de funcionários.
--
-- hr_employees é um cadastro NOVO e independente de app_users (contas de
-- login): a maioria dos funcionários não acessa o sistema, e app_users não
-- tem CPF/admissão/cargo/salário/PIX. O vínculo com uma conta é opcional
-- (user_id, sem FK — convenção do projeto de relacionar por convenção).
--
-- Como não existe tabela SQL de lojas (o cadastro vive em shared_state sob
-- 'companies_list'), toda tabela guarda company_id + company_name
-- desnormalizados, igual ao restante do Financeiro.
--
-- A Folha NÃO guarda colunas de Comissão/Benefícios: os dois são sempre
-- recalculados ao vivo a partir de hr_commissions e hr_benefits, pra folha
-- nunca divergir da fonte (ver app/api/hr-payroll/shared.ts). Já
-- hr_commissions guarda quatro somas desnormalizadas dos seus
-- hr_commission_items, recalculadas no mesmo batch sempre que os itens
-- mudam — discounts_cents é magnitude positiva (subtraída na fórmula) e
-- adjustments_cents é o único com sinal. Valor final do comissionamento
-- (calculado na leitura):
--   commission + bonuses + premiums - discounts + adjustments
--
-- Todo o módulo é liberado por uma única permissão nova, "payroll:manage",
-- independente de "finance:manage".
CREATE TABLE "hr_benefits" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"month" text NOT NULL,
	"type" text DEFAULT 'outros' NOT NULL,
	"payment_method" text DEFAULT 'outros' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"payment_date" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_commission_items" (
	"id" text PRIMARY KEY NOT NULL,
	"commission_id" text NOT NULL,
	"preset_id" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'bonus' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_commission_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'bonus' NOT NULL,
	"default_amount_cents" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_commissions" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"month" text NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"bonuses_cents" integer DEFAULT 0 NOT NULL,
	"premiums_cents" integer DEFAULT 0 NOT NULL,
	"discounts_cents" integer DEFAULT 0 NOT NULL,
	"adjustments_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_employees" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"cpf" text DEFAULT '' NOT NULL,
	"admission_date" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"role_title" text DEFAULT '' NOT NULL,
	"salary_cents" integer DEFAULT 0 NOT NULL,
	"pix_key" text DEFAULT '' NOT NULL,
	"bank_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"month" text NOT NULL,
	"base_salary_cents" integer DEFAULT 0 NOT NULL,
	"bonus_cents" integer DEFAULT 0 NOT NULL,
	"overtime_cents" integer DEFAULT 0 NOT NULL,
	"additions_cents" integer DEFAULT 0 NOT NULL,
	"deductions_cents" integer DEFAULT 0 NOT NULL,
	"other_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"payment_done" integer DEFAULT 0 NOT NULL,
	"payment_date" text DEFAULT '' NOT NULL,
	"attachment_file_name" text DEFAULT '' NOT NULL,
	"attachment_r2_key" text DEFAULT '' NOT NULL,
	"attachment_size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_benefits_employee_month_idx" ON "hr_benefits" USING btree ("employee_id","month");--> statement-breakpoint
CREATE INDEX "hr_benefits_month_idx" ON "hr_benefits" USING btree ("month");--> statement-breakpoint
CREATE INDEX "hr_commission_items_commission_idx" ON "hr_commission_items" USING btree ("commission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_commissions_employee_month_idx" ON "hr_commissions" USING btree ("employee_id","month");--> statement-breakpoint
CREATE INDEX "hr_commissions_month_idx" ON "hr_commissions" USING btree ("month");--> statement-breakpoint
CREATE INDEX "hr_commissions_company_idx" ON "hr_commissions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_employees_cpf_idx" ON "hr_employees" USING btree ("cpf") WHERE cpf <> '';--> statement-breakpoint
CREATE INDEX "hr_employees_company_idx" ON "hr_employees" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "hr_employees_status_idx" ON "hr_employees" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_payroll_entries_employee_month_idx" ON "hr_payroll_entries" USING btree ("employee_id","month");--> statement-breakpoint
CREATE INDEX "hr_payroll_entries_month_idx" ON "hr_payroll_entries" USING btree ("month");--> statement-breakpoint
CREATE INDEX "hr_payroll_entries_company_idx" ON "hr_payroll_entries" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "hr_employees" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "hr_employees" FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE "hr_payroll_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "hr_payroll_entries" FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE "hr_benefits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "hr_benefits" FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE "hr_commission_presets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "hr_commission_presets" FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE "hr_commissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "hr_commissions" FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE "hr_commission_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "hr_commission_items" FROM anon, authenticated;