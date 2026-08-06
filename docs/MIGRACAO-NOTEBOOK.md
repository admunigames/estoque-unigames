# Migração para outro computador

## Preparação no computador atual

1. Confirmar que o código está no GitHub.
2. Guardar o `.env` em local seguro; ele não deve entrar no GitHub.
3. Exportar separadamente dados do D1/Notion e arquivos importantes do armazenamento.
4. Manter o backup local até o novo computador passar pelos testes.

## Configuração no notebook

Instalar Node.js 22.13 ou superior, Git, pnpm e VS Code. Os scripts do projeto são compatíveis com PowerShell e outros terminais. Depois:

```bash
git clone https://github.com/admunigames/estoque-unigames.git
cd estoque-unigames
pnpm install
```

Criar o `.env` a partir do `.env.example`, preenchendo os valores reais de forma segura. Para validar o projeto:

```bash
pnpm check
```

## Rotina de trabalho

Antes de editar, atualizar a branch `main`. Depois de testar, criar uma branch de alteração, fazer commit e abrir um PR. A publicação no Sites só deve usar uma versão validada.
