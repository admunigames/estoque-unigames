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

Toda alteração deve ser validada e enviada ao GitHub antes da publicação no
ChatGPT Sites. A hospedagem deve reutilizar o projeto definido em
`.openai/hosting.json`, mantendo o mesmo endereço e o mesmo banco D1.

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
produtos, dados processados e relatórios são persistidos no banco D1
compartilhado do site. O Controle de Compras permanece no Notion e seus anexos
temporários usam o armazenamento R2.
