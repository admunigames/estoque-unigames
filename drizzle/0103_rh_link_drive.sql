-- RH > Funcionários: link da pasta do Drive com os documentos do funcionário.
-- Só ADD COLUMN: nada é apagado.
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "drive_link" text DEFAULT '' NOT NULL;
