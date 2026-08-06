# Organização do projeto

Atualizado em 06/08/2026.

## Fonte principal

- Repositório oficial: `https://github.com/admunigames/estoque-unigames`
- Branch de trabalho: `main`
- Publicação atual: ChatGPT Sites, usando o projeto definido em `.openai/hosting.json`.
- Dados operacionais: D1 e Notion; não ficam salvos como arquivos dentro do repositório.

## Pastas que pertencem ao código

- `app/`: páginas, APIs e componentes da aplicação.
- `db/` e `drizzle/`: esquema e migrações do banco.
- `public/`: arquivos públicos, PWA e identidade visual.
- `worker/`: entrada do Worker da hospedagem.
- `tests/`: testes automatizados.
- `docs/`: documentação de manutenção e migração.

## Arquivos gerados ou locais

`node_modules/`, `dist/`, `build/`, `.wrangler/`, `.next/` e `*.tsbuildinfo` são resultados locais. Eles não devem ser transportados para outro computador nem enviados ao GitHub; podem ser recriados com a instalação das dependências e o build.

Arquivos `.env` contêm credenciais e devem permanecer somente no computador ou no gerenciador de segredos. Apenas `.env.example` pode ser versionado.

## Backup realizado

O backup de 06/08/2026 foi salvo fora do código, em `backups/2026-08-06-inventario/`. Ele contém uma cópia do código sem dependências geradas e um arquivo ZIP do último commit local antes da organização.

## Regra para o próximo computador

Clonar o repositório oficial em uma pasta própria, instalar as dependências e recriar o `.env` local. Não copiar `node_modules` ou credenciais do computador antigo.
