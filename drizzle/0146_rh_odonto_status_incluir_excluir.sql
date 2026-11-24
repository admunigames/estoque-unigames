-- RH > Plano Odontológico (24/11/2026): status FALTANDO e SOLICITADA
-- separados em INCLUIR/EXCLUIR e MOTIVO como código minúsculo (a CAIXA ALTA
-- gravava "EXCLUSAO" e a tela não mostrava). Só dados, sem mudar colunas.
-- Antigos: motivo EXCLUSÃO ou funcionário inativo → EXCLUIR; senão INCLUIR.
-- Idempotente (só toca os valores antigos).
UPDATE "hr_dental_plan" SET "reason" = LOWER("reason") WHERE "reason" <> LOWER("reason");--> statement-breakpoint
UPDATE "hr_dental_plan" d SET "status" = CASE
    WHEN d."reason" = 'exclusao' OR EXISTS (SELECT 1 FROM "hr_employees" e WHERE e."id" = d."employee_id" AND e."status" = 'inactive')
      THEN 'faltando_excluir' ELSE 'faltando_incluir' END
  WHERE d."status" = 'faltando_incluir_excluir';--> statement-breakpoint
UPDATE "hr_dental_plan" d SET "status" = CASE
    WHEN d."reason" = 'exclusao' OR EXISTS (SELECT 1 FROM "hr_employees" e WHERE e."id" = d."employee_id" AND e."status" = 'inactive')
      THEN 'exclusao_solicitada' ELSE 'inclusao_solicitada' END
  WHERE d."status" = 'inclusao_exclusao_solicitada';--> statement-breakpoint
UPDATE "hr_dental_plan" SET "reason" = CASE
    WHEN "status" IN ('incluso', 'faltando_incluir', 'inclusao_solicitada') THEN 'inclusao' ELSE 'exclusao' END
  WHERE "reason" = '';
--> statement-breakpoint
ALTER TABLE "hr_dental_plan" ALTER COLUMN "status" SET DEFAULT 'faltando_incluir';
