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

## Ilhas React

A interface é a SPA vanilla `public/estoque.html`. React entra só como
"ilhas": um componente que desenha UMA área da tela, carregado quando essa
tela abre. Use para telas/módulos NOVOS ou áreas isoladas; não reescreva o
que já funciona. Piloto: aba DASHBOARD de Divergências.

- **Estrutura:** `islands/<nome>/index.tsx` (montagem) + componentes `.tsx`
  + lógica pura em `.ts` (testável no Node: o runner usa
  `--experimental-strip-types`, que não aceita TSX). Utilitário comum em
  `islands/shared/create-island.tsx`.
- **Nova ilha:** crie a pasta `islands/<nome-em-kebab-case>/` com `index.tsx`;
  o `vite.islands.config.ts` acha a entrada sozinho. `pnpm islands:build`
  (também rodado por `pnpm build`/`pnpm dev`, antes do vinext) gera
  `public/islands/` (fora do git) e `public/islands/manifest.json`.
  `pnpm islands:watch` recompila ao salvar; se o `pnpm dev` não achar um
  arquivo recém-gerado, reinicie-o (o vinext lista `public/` ao montar as
  rotas).
- **Regra do React compartilhado:** `react`, `react-dom` e `react/jsx-runtime`
  ficam em UM arquivo, `islands/vendor-react-<hash>.js` (~60 KB gzip), que
  todas as ilhas importam e o navegador baixa uma vez. Nunca embutir React
  em uma ilha: o build falha e `tests/islands-divergences-dashboard.test.mjs`
  também.
- **Carregador:** no `estoque.html`, `loadIsland('<nome>')` lê o manifest
  (`cache:'no-store'`), injeta o `<script type="module">` e devolve a API.
  Nenhuma outra tela baixa React.
- **Contrato:** o bundle registra
  `window.UnigamesIslands.<nomeEmCamelCase> = { mount(container, props), update(props), unmount() }`
  (via `createIsland`). Busca de dados, filtros, permissões e escopo por loja
  continuam no vanilla, que chama `mount`/`update` com os dados prontos.
- **Reserva obrigatória:** o renderizador vanilla antigo NÃO é apagado. Uma
  constante liga a ilha (ex.: `DIV_DASHBOARD_REACT`); se o manifest/script
  falhar ou a ilha lançar erro (`mount`/`update` relançam erros de render),
  registra `console.error` e cai no vanilla.
- **Estilo:** DOM normal (sem Shadow DOM) com as classes CSS que já existem
  no `estoque.html`; sem Tailwind, CSS-in-JS, biblioteca de gráficos ou de
  componentes; sem SVG/emoji novos; nada de `dangerouslySetInnerHTML` (o
  lint bloqueia). Respeite `prefers-reduced-motion` e os temas claro/escuro.
- **Cache:** o service worker busca `/islands/manifest.json` sempre na rede
  e guarda os módulos com hash (cache-first).

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
