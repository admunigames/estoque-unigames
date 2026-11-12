-- Compras (12/11/2026): custo atual da Unigames (coluna "Custo" do Relatório
-- de Produto subido em Base de Dados > Cadastro de Produtos). Com a quantidade
-- do estoque geral (Relatório 41) dá o custo médio do texto da divisão do
-- pedido. NULL = sem custo no relatório. Só ADD COLUMN: nada é apagado.
ALTER TABLE "product_catalog" ADD COLUMN IF NOT EXISTS "cost_cents" integer;
