CREATE TABLE "supply_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "supply_categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "supply_products" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"stock_qty" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "supply_products_category_idx" ON "supply_products" USING btree ("category_id","name");--> statement-breakpoint
CREATE INDEX "supply_products_active_idx" ON "supply_products" USING btree ("active");
-- Seed: categorias e produtos iniciais de insumos (estoque inicial 0)
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_adesivos', 'ADESIVOS') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_alimenticios', 'ALIMENTÍCIOS') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_bobinas', 'BOBINAS') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_caixas_e_sacolas', 'CAIXAS E SACOLAS') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_limpeza', 'LIMPEZA') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_materiais_de_escritorio', 'MATERIAIS DE ESCRITÓRIO') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_outros', 'OUTROS') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_papelaria', 'PAPELARIA') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_sacos', 'SACOS') ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_categories" ("id", "name") VALUES ('cat_tinta_de_impressora', 'TINTA DE IMPRESSORA') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_adesivo_bolinha_p_selar_produtos', 'cat_adesivos', 'ADESIVO BOLINHA P/SELAR PRODUTOS', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_adesivo_contato_telefone_sacola_m', 'cat_adesivos', 'ADESIVO CONTATO/TELEFONE SACOLA M', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_etiqueta_de_os', 'cat_adesivos', 'ETIQUETA DE OS', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_etiqueta_de_precificadora', 'cat_adesivos', 'ETIQUETA DE PRECIFICADORA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_etiqueta_seminovo', 'cat_adesivos', 'ETIQUETA SEMINOVO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_hang_tab_p_gancho', 'cat_adesivos', 'HANG TAB P/GANCHO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_selo_de_garantia_maior', 'cat_adesivos', 'SELO DE GARANTIA MAIOR', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_selo_de_garantia_menor', 'cat_adesivos', 'SELO DE GARANTIA MENOR', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_selo_redondo_garantia_loja', 'cat_adesivos', 'SELO REDONDO "GARANTIA LOJA"', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_biscoito', 'cat_alimenticios', 'BISCOITO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_capsula_de_cafe', 'cat_alimenticios', 'CAPSULA DE CAFE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_copo_descartavel', 'cat_alimenticios', 'COPO DESCARTAVEL', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_guardanapo', 'cat_alimenticios', 'GUARDANAPO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pa_p_mexer_cafe', 'cat_alimenticios', 'PA P/MEXER CAFE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sache_adocante', 'cat_alimenticios', 'SACHE ADOÇANTE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sache_de_acucar', 'cat_alimenticios', 'SACHE DE AÇUCAR', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_bobina_maquineta_rede', 'cat_bobinas', 'BOBINA MAQUINETA REDE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_bobina_maquineta_stone', 'cat_bobinas', 'BOBINA MAQUINETA STONE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_bobina_termica', 'cat_bobinas', 'BOBINA TERMICA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_caixa_assistencia_bancada', 'cat_caixas_e_sacolas', 'CAIXA ASSISTENCIA BANCADA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_caixa_assistencia_console', 'cat_caixas_e_sacolas', 'CAIXA ASSISTENCIA CONSOLE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_caixa_assistencia_controle', 'cat_caixas_e_sacolas', 'CAIXA ASSISTENCIA CONTROLE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sacola_de_presente_m_unigames', 'cat_caixas_e_sacolas', 'SACOLA DE PRESENTE M (UNIGAMES)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sacola_de_presente_p_unigames_e_pa', 'cat_caixas_e_sacolas', 'SACOLA DE PRESENTE P (UNIGAMES E PA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sacola_g_unigames_e_pa', 'cat_caixas_e_sacolas', 'SACOLA G (UNIGAMES E PA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sacola_gg_unigames_e_pa', 'cat_caixas_e_sacolas', 'SACOLA GG (UNIGAMES E PA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sacola_m_unigames_e_pa', 'cat_caixas_e_sacolas', 'SACOLA M (UNIGAMES E PA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sacola_p_unigames_e_pa', 'cat_caixas_e_sacolas', 'SACOLA P (UNIGAMES E PA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_sacola_transporte_uber', 'cat_caixas_e_sacolas', 'SACOLA TRANSPORTE UBER', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_agua_sanitaria', 'cat_limpeza', 'AGUA SANITÁRIA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_alcool', 'cat_limpeza', 'ALCOOL', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_alcool_isopropilico', 'cat_limpeza', 'ALCOOL ISOPROPILICO', 0, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_algodao_hidrofilo_assistencia', 'cat_limpeza', 'ALGODAO HIDROFILO (ASSISTENCIA)', 0, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_cotonete_assistencia', 'cat_limpeza', 'COTONETE (ASSISTENCIA)', 0, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_desinfetante', 'cat_limpeza', 'DESINFETANTE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_detergente', 'cat_limpeza', 'DETERGENTE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_espanador_de_po', 'cat_limpeza', 'ESPANADOR DE PO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_esponja_de_louca', 'cat_limpeza', 'ESPONJA DE LOUÇA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_flanela_laranja', 'cat_limpeza', 'FLANELA (LARANJA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_limpa_tela', 'cat_limpeza', 'LIMPA TELA', 0, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_limpa_vidro', 'cat_limpeza', 'LIMPA VIDRO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_lixeira', 'cat_limpeza', 'LIXEIRA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_mop_completo', 'cat_limpeza', 'MOP (COMPLETO)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_mop_redondo_refil', 'cat_limpeza', 'MOP REDONDO (REFIL)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_mop_retangulo_refil', 'cat_limpeza', 'MOP RETÂNGULO (REFIL)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_multiuso_veja', 'cat_limpeza', 'MULTIUSO (VEJA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pa_completa', 'cat_limpeza', 'PA (COMPLETA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pa_parte_de_baixo', 'cat_limpeza', 'PA (PARTE DE BAIXO)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pano_de_chao', 'cat_limpeza', 'PANO DE CHÃO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pano_de_microfibra', 'cat_limpeza', 'PANO DE MICROFIBRA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pano_multiuso_perfex', 'cat_limpeza', 'PANO MULTIUSO (PERFEX)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_papel_higienico', 'cat_limpeza', 'PAPEL HIGIENICO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_papel_toalha', 'cat_limpeza', 'PAPEL TOALHA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_rodo', 'cat_limpeza', 'RODO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_saco_de_lixo_100l_riomar', 'cat_limpeza', 'SACO DE LIXO 100L (RIOMAR)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_saco_de_lixo_40l', 'cat_limpeza', 'SACO DE LIXO 40L', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_saco_de_lixo_60l', 'cat_limpeza', 'SACO DE LIXO 60L', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_vassoura_completa', 'cat_limpeza', 'VASSOURA (COMPLETA)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_vassoura_parte_de_baixo_base', 'cat_limpeza', 'VASSOURA (PARTE DE BAIXO - BASE)', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_bandeja_de_organizar_papel', 'cat_materiais_de_escritorio', 'BANDEJA DE ORGANIZAR PAPEL', 0, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pasta_a4', 'cat_materiais_de_escritorio', 'PASTA A4', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pasta_a4_sanfonada_12_divisorias', 'cat_materiais_de_escritorio', 'PASTA A4 SANFONADA - 12 DIVISÓRIAS', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_pasta_sanfonada_26x15_12_divisorias', 'cat_materiais_de_escritorio', 'PASTA SANFONADA 26X15 - 12 DIVISÓRIAS', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_porta_lapis', 'cat_materiais_de_escritorio', 'PORTA LAPIS', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_precificadora', 'cat_materiais_de_escritorio', 'PRECIFICADORA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_box_p_jogo', 'cat_outros', 'BOX P/JOGO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_expositor_de_acrilico', 'cat_outros', 'EXPOSITOR DE ACRILICO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_fechadura_jacare_p_vitrine', 'cat_outros', 'FECHADURA JACARE P/ VITRINE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_fita_3m', 'cat_outros', 'FITA 3M', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_gancho', 'cat_outros', 'GANCHO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_placa_proibido_sentar', 'cat_outros', 'PLACA "PROIBIDO SENTAR"', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_plastico_bolha', 'cat_outros', 'PLASTICO BOLHA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_plastico_filme', 'cat_outros', 'PLÁSTICO FILME', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_trava_antifurto_p_gancho', 'cat_outros', 'TRAVA ANTIFURTO P/GANCHO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_wd40', 'cat_outros', 'WD40', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_caneta', 'cat_papelaria', 'CANETA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_clipe_de_papel', 'cat_papelaria', 'CLIPE DE PAPEL', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_cola_bastao', 'cat_papelaria', 'COLA BASTÃO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_envelope_a4', 'cat_papelaria', 'ENVELOPE A4', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_estilete', 'cat_papelaria', 'ESTILETE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_fita_adesiva_azul', 'cat_papelaria', 'FITA ADESIVA AZUL', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_fita_adesiva_fina', 'cat_papelaria', 'FITA ADESIVA FINA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_fita_adesiva_grossa', 'cat_papelaria', 'FITA ADESIVA GROSSA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_fita_crepe', 'cat_papelaria', 'FITA CREPE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_grampeador', 'cat_papelaria', 'GRAMPEADOR', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_grampo', 'cat_papelaria', 'GRAMPO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_lapis_de_cor', 'cat_papelaria', 'LAPIS DE COR', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_lapiseira', 'cat_papelaria', 'LAPISEIRA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_liga_elastica', 'cat_papelaria', 'LIGA ELASTICA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_papel_cartao', 'cat_papelaria', 'PAPEL CARTAO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_papel_foto_adesivo', 'cat_papelaria', 'PAPEL FOTO/ADESIVO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_papel_rascunho', 'cat_papelaria', 'PAPEL RASCUNHO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_piloto_ponta_fina_e_grossa', 'cat_papelaria', 'PILOTO PONTA FINA E GROSSA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_post_it', 'cat_papelaria', 'POST-IT', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_resma_a4', 'cat_papelaria', 'RESMA A4', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_tesoura_grande', 'cat_papelaria', 'TESOURA GRANDE', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_tesoura_pequena', 'cat_papelaria', 'TESOURA PEQUENA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_saco_p_grip', 'cat_sacos', 'SACO P/ GRIP', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_saco_p_controle_ou_jogo', 'cat_sacos', 'SACO P/CONTROLE OU JOGO', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_saco_para_cabo_menor', 'cat_sacos', 'SACO PARA CABO MENOR', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_saco_pra_cabo_maior', 'cat_sacos', 'SACO PRA CABO MAIOR', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_tinta_amarela', 'cat_tinta_de_impressora', 'TINTA AMARELA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_tinta_azul', 'cat_tinta_de_impressora', 'TINTA AZUL', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_tinta_magenta', 'cat_tinta_de_impressora', 'TINTA MAGENTA', 1, 0) ON CONFLICT (id) DO NOTHING;
INSERT INTO "supply_products" ("id", "category_id", "name", "active", "stock_qty") VALUES ('prod_tinta_preta', 'cat_tinta_de_impressora', 'TINTA PRETA', 1, 0) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
