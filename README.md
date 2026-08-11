# Estoque Unigames

Sistema web para operações das lojas Unigames, com módulos individuais por
usuário, controle de acesso e funcionamento instalável como aplicativo.

## Funcionalidades

- dashboard e divergências de estoque;
- cadastros de lojas e bases de produtos;
- criação e acompanhamento de puxadas;
- tarefas individuais, recorrentes e com lembretes;
- missões por loja e instruções gerais com histórico;
- Relatório 41 por loja com exportação em TXT;
- banco geral compartilhado para Cadastros, Dados, Dashboard e Puxadas;
- controle de compras sincronizado com o Notion;
- anexos de pedidos e notas fiscais;
- notificações push e preferências visuais por usuário;
- funcionamento parcial sem internet por PWA;
- acesso protegido por usuário, senha e sessão assinada no servidor.

## Desenvolvimento local

Requer Node.js `>=22.13.0`.

```bash
pnpm install
pnpm dev
```

Para validar lint, tipos, build e testes:

```bash
pnpm check
```

## Fonte principal e publicação

O código-fonte completo e atualizado é mantido em
`https://github.com/admunigames/estoque-unigames`.

A hospedagem roda em infraestrutura Cloudflare própria (Worker + Assets),
configurada em `wrangler.jsonc`. Todo push na branch `main` dispara lint,
tipos, testes, build e deploy automático via GitHub Actions
(`.github/workflows/deploy.yml`).

## Configuração segura

Copie `.env.example` para um arquivo `.env` local e preencha:

- `APP_LOGIN_USER`: usuário compartilhado para acesso;
- `APP_LOGIN_PASSWORD`: senha forte, nunca enviada ao GitHub;
- `APP_SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres;
- `NOTION_TOKEN`: token da integração interna do Notion;
- `NOTION_DATA_SOURCE_ID`: identificador da base Controle de Compras.
- `VAPID_PUBLIC_KEY`: chave pública usada para inscrever os aparelhos;
- `VAPID_PRIVATE_KEY`: chave privada usada pelo servidor para enviar avisos;
- `VAPID_SUBJECT`: contato do emissor no formato `mailto:contato@dominio.com`.

Na hospedagem, esses valores devem ser configurados como variáveis de ambiente.
Nunca publique credenciais no código ou no histórico do Git.

## Segurança

Todas as páginas, arquivos estáticos e APIs passam pela proteção do Worker. A
sessão usa cookie `HttpOnly`, `Secure` em produção, `SameSite=Strict`, assinatura
HMAC-SHA-256 e expiração de 12 horas. Requisições de alteração também validam a
origem antes de alcançar as APIs. Tentativas repetidas de login recebem bloqueio
temporário.

## Persistência

Cadastros, usuários, tarefas, missões, instruções, preferências, bases de
produtos, dados processados e relatórios são persistidos no **Supabase
(Postgres)**, acessado pelo Worker através do **Cloudflare Hyperdrive**
(binding `HYPERDRIVE` em `wrangler.jsonc`) — necessário porque uma conexão
TCP direta do Worker ao Postgres esbarra no limite de subrequests por
invocação. O binding D1 (`estoque-unigames-db`) continua presente como rede
de segurança para rollback (`DB_DRIVER=d1` em `wrangler.jsonc`), mas não é
mais o banco em uso; para reverter, basta trocar `DB_DRIVER` para `d1` e
fazer novo deploy. O Controle de Compras permanece no Notion e seus anexos
temporários usam o armazenamento R2.

Para rodar comandos do `drizzle-kit` (gerar/aplicar migrations) contra o
Supabase, defina `SUPABASE_DB_URL` no ambiente (ver `.env.example`) apontando
para a connection string do "Session pooler" do projeto no Supabase.
