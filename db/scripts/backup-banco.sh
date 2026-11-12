#!/usr/bin/env bash
# Gera uma cópia completa das tabelas do app no Supabase (schemas "public" e
# "drizzle": estrutura, índices e dados) no formato custom do pg_dump, que o
# pg_restore lê de volta. Copia as tabelas, não os schemas: assim uma
# restauração com --clean recria só as tabelas e não apaga o schema "public"
# nem as permissões que o próprio Supabase configura nele. (As migrations em
# drizzle/ só criam tabelas; se um dia surgirem funções, tipos ou views,
# este script precisa passar a incluí-los.)
# Usado pelo workflow .github/workflows/backup-banco.yml; também serve para
# um backup manual antes de uma mudança arriscada.
#
# Uso:
#   SUPABASE_DB_URL="postgresql://..." bash db/scripts/backup-banco.sh arquivo.dump
#
# PG_BIN (opcional) aponta para a pasta dos binários do Postgres, quando o
# pg_dump da versão do servidor não é o padrão do sistema.

set -euo pipefail

OUT="${1:?Uso: backup-banco.sh <arquivo.dump>}"
: "${SUPABASE_DB_URL:?Defina SUPABASE_DB_URL antes de rodar este script.}"
PG_BIN="${PG_BIN:-}"

run_pg() {
  local cmd="$1"
  shift
  "${PG_BIN:+$PG_BIN/}$cmd" "$@"
}

run_pg pg_dump "$SUPABASE_DB_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --table='public.*' \
  --table='drizzle.*' \
  --file="$OUT"

# Confere se o arquivo abre e tem dados de verdade antes de guardá-lo.
TABLES=$(run_pg pg_restore --list "$OUT" | grep -c " TABLE DATA " || true)
if [ "$TABLES" -eq 0 ]; then
  echo "Backup sem nenhuma tabela com dados: $OUT" >&2
  exit 1
fi

echo "Backup gerado: $OUT ($(du -h "$OUT" | cut -f1), $TABLES tabelas)"
