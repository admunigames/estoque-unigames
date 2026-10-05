-- Assistência: "MÃO DE OBRA" (R$ 99,99) em todos os aparelhos da tabela de
-- valores, logo depois do último defeito de cada aparelho.
INSERT INTO "assist_defects" ("id", "category", "device", "name", "min_cents", "max_cents", "quote_only", "sort_order")
SELECT 'assist-mdo-' || ROW_NUMBER() OVER (ORDER BY MIN("sort_order")), MIN("category"), "device", 'MÃO DE OBRA', 9999, 9999, 0, MAX("sort_order")
FROM "assist_defects"
WHERE true
GROUP BY "device"
ON CONFLICT ("device", "name") DO NOTHING;
