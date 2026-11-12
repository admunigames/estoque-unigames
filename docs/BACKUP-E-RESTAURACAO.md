# Backup e restauração

O que fica protegido e como recuperar cada parte.

| O quê | Onde fica a cópia | Por quanto tempo |
| --- | --- | --- |
| Código do site | GitHub: histórico da `main` + uma etiqueta `producao-…` por publicação | Para sempre |
| Dados do banco (Supabase) | R2 da Cloudflare, bucket privado `estoque-unigames-backups`, pasta `banco/` | 30 dias (uma cópia por dia) |

Ficam de fora: os anexos do R2 (`estoque-unigames-uploads`) e o Controle de
Compras no Notion, que tem o histórico do próprio Notion.

## Configuração (uma vez só)

O backup do código já funciona sozinho. O do banco precisa de dois ajustes:

1. **Segredo `SUPABASE_DB_URL` no GitHub.** No Supabase, abra o projeto >
   botão **Connect** > **Session pooler** e copie a connection string (porta
   `5432`, usuário `postgres.<projeto>`), trocando `[YOUR-PASSWORD]` pela senha
   do banco. No GitHub: **Settings > Secrets and variables > Actions > New
   repository secret**, nome `SUPABASE_DB_URL`, cole o valor. Use o *Session
   pooler*: a conexão direta só funciona por IPv6, que o GitHub Actions não
   tem.
2. **Permissão de R2 no token da Cloudflare.** O token já salvo em
   `CLOUDFLARE_API_TOKEN` precisa de **Account > Workers R2 Storage > Edit**.
   Na Cloudflare: **My Profile > API Tokens**, edite o token do deploy e
   acrescente essa permissão.

Depois rode o primeiro backup na mão: **Actions > Backup do banco > Run
workflow**. Essa primeira execução cria o bucket e a regra que apaga cópias
com mais de 30 dias. A partir daí ele roda sozinho todo dia às 03:17
(horário de Brasília). Se algum dia falhar, o GitHub manda e-mail avisando.

## Voltar o site para uma versão anterior

Cada publicação na `main` ganha uma etiqueta com a data e a hora, por exemplo
`producao-2026-10-28-153012`. A lista fica no GitHub, em **Code > Tags**.

1. Abra **Actions > Restaurar versão do site > Run workflow**.
2. Em `versao`, cole a etiqueta (ou o código de um commit) e confirme.
3. Em uns 3 minutos essa versão está no ar.

Isso **não** altera a `main`. O próximo push na `main` publica de novo a
versão atual por cima. Para deixar a volta definitiva, peça ao Claude para
desfazer a mudança na `main`; aí o deploy normal publica a versão corrigida.

Para uma emergência de segundos, a Cloudflare também volta versões: **Workers
& Pages > estoque-unigames > Deployments**, escolha uma versão anterior >
**Rollback**.

Cuidado: se entre a versão antiga e a atual houve mudança no banco (uma
migration nova em `drizzle/`), a versão antiga pode não funcionar com o banco
atual. Na dúvida, peça ajuda antes.

## Recuperar os dados do banco

Restaurar substitui as tabelas do banco pelo conteúdo da cópia: tudo o que
foi lançado depois dela se perde. Antes de restaurar, rode **Backup do banco**
na mão para guardar o estado atual.

1. **Baixe a cópia.** Na Cloudflare: **R2 > estoque-unigames-backups >
   banco/**, escolha o arquivo do dia e clique em **Download**. Ou pelo
   terminal:

   ```bash
   pnpm exec wrangler r2 object get \
     estoque-unigames-backups/banco/estoque-unigames-2026-10-28-0317.dump \
     --file backup.dump --remote
   ```

2. **Restaure** com o `pg_restore` da mesma versão do Postgres do Supabase,
   usando a connection string do *Session pooler*:

   ```bash
   # Tudo
   pg_restore --clean --if-exists --no-owner --no-privileges \
     -d "$SUPABASE_DB_URL" backup.dump

   # Só uma tabela (ex.: app_users)
   pg_restore --clean --if-exists --no-owner --no-privileges \
     -t app_users -d "$SUPABASE_DB_URL" backup.dump
   ```

   A cópia guarda as tabelas, não os schemas: o `--clean` apaga e recria só
   as tabelas que estão na cópia, sem mexer no schema `public` nem nas
   permissões que o Supabase configura nele. Para restaurar num banco novo e
   vazio, crie antes o schema `drizzle` (`CREATE SCHEMA drizzle;`).

Para um backup manual fora do GitHub (por exemplo, antes de uma mudança
arriscada no banco):

```bash
SUPABASE_DB_URL="postgresql://..." bash db/scripts/backup-banco.sh backup.dump
```

Esse arquivo tem dados de clientes e funcionários: não envie ao GitHub e
apague depois de usar.
