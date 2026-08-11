# Fluxo obrigatório do projeto

Este repositório é a fonte principal do Estoque Unigames:
`https://github.com/admunigames/estoque-unigames`.

## Antes de alterar

- Confirme que o projeto aberto pertence a este repositório.
- Atualize a referência da branch `main` no GitHub antes de editar.
- Preserve mudanças locais do usuário e nunca sobrescreva trabalho não relacionado.

## Depois de alterar

- Valide a aplicação e os fluxos afetados.
- Registre e envie a versão validada ao GitHub antes de publicar o site.
- Mantenha `main` como a cópia completa e atual do projeto, salvo pedido explícito por outro fluxo.
- Nunca envie arquivos `.env`, senhas, tokens, credenciais ou dados exportados de usuários.

## Hospedagem

- Produção roda em Cloudflare própria (Worker + Assets), definida em
  `wrangler.jsonc`; deploy automático via GitHub Actions a cada push em
  `main`. `.openai/hosting.json` só é usado pelo `pnpm dev` local.
- Não crie outro Worker, banco D1 ou projeto Supabase para uma atualização
  normal.
- Preserve o endereço publicado e os bindings existentes (D1, Hyperdrive, R2).
- O GitHub guarda o código-fonte; os dados operacionais ficam no Supabase
  (Postgres, via Hyperdrive — ver README) e no Notion. O binding D1 continua
  presente só como rede de segurança para rollback (`DB_DRIVER=d1`).

