-- Compras (12/11/2026): preço de VENDA da Unigames (coluna "Preço" do
-- Relatório de Produto subido em Base de Dados > Cadastro de Produtos), usado
-- no texto da divisão do pedido ("CUSTO: R$ x - VENDA: R$ y"). P.A não guarda
-- preço (o usuário digita à mão). NULL = sem preço no relatório.
-- Só ADD COLUMN: nada é apagado.
ALTER TABLE "product_catalog" ADD COLUMN IF NOT EXISTS "sale_price_cents" integer;
