-- RH > Funcionários (23/11/2026): RECEBE TRANSPORTE? no cadastro. 1 = SIM
-- (padrão: todos os atuais continuam recebendo), 0 = NÃO (o ciclo de
-- benefícios não paga passagem). Só ADD COLUMN com default. Idempotente.
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "receives_transport" integer DEFAULT 1 NOT NULL;
