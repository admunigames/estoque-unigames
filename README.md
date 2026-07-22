# Estoque Unigames

Sistema web para reconciliação de estoque, puxadas entre lojas e controle de
compras integrado ao Notion.

## Funcionalidades

- dashboard e divergências de estoque;
- cadastros de lojas e dados locais;
- criação e acompanhamento de puxadas;
- controle de compras sincronizado com o Notion;
- anexos de pedidos e notas fiscais;
- acesso protegido por usuário, senha e sessão assinada no servidor.

## Desenvolvimento local

Requer Node.js `>=22.13.0`.

```bash
pnpm install
pnpm dev
```

Para validar a versão de produção:

```bash
pnpm build
```

## Configuração segura

Copie `.env.example` para um arquivo `.env` local e preencha:

- `APP_LOGIN_USER`: usuário compartilhado para acesso;
- `APP_LOGIN_PASSWORD`: senha forte, nunca enviada ao GitHub;
- `APP_SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres;
- `NOTION_TOKEN`: token da integração interna do Notion;
- `NOTION_DATA_SOURCE_ID`: identificador da base Controle de Compras.

Na hospedagem, esses valores devem ser configurados como variáveis de ambiente.
Nunca publique credenciais no código ou no histórico do Git.

## Segurança

Todas as páginas, arquivos estáticos e APIs passam pela proteção do Worker. A
sessão usa cookie `HttpOnly`, `Secure` em produção, `SameSite=Strict`, assinatura
HMAC-SHA-256 e expiração de 12 horas. Tentativas repetidas de login recebem
bloqueio temporário.
