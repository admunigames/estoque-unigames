-- 13º SALÁRIO (27/11/2026, pedido do usuário): lançamentos em PARCELA ÚNICA
-- passam a ADIANTAMENTO (a tela só tem ADIANTAMENTO e PARCELA FINAL agora).
-- Se o funcionário já tem ADIANTAMENTO no mesmo ano, o ÚNICO fica como está
-- (não junta valores) — aparece como ÚNICO nos LANÇAMENTOS para conferir à mão.
UPDATE "hr_thirteenth_salary" AS u
SET "installment" = 'adiantamento', "updated_by_name" = 'MIGRAÇÃO 0148', "updated_at" = now()::text
WHERE u."installment" = 'unico'
  AND NOT EXISTS (
    SELECT 1 FROM "hr_thirteenth_salary" AS a
    WHERE a."employee_id" = u."employee_id" AND a."year" = u."year" AND a."installment" = 'adiantamento'
  );
