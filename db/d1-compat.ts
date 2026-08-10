import type postgres from "postgres";

// Adapter que expõe uma API compatível com D1Database (prepare/bind/run/
// all/first + batch) por cima do client Postgres (postgres-js).
//
// Objetivo: os >100 pontos do código que hoje fazem
//   env.DB.prepare(sql).bind(...).run()/.all()/.first()
// continuam funcionando SEM mudar de forma — só troca-se de onde vem o
// `DB` (ver db/index.ts). Isso limita o trabalho de migração real a
// auditar/ajustar o texto das queries que usam sintaxe exclusiva do
// SQLite (PRAGMA, strftime, INSERT OR IGNORE/REPLACE, etc.), em vez de
// reescrever cada call site para uma API de client diferente.
//
// Isso NÃO é um adapter D1 genérico — implementa só o subconjunto que
// este projeto usa (prepare/bind/run/all/first/raw, batch). Constructs
// exclusivos de SQLite são detectados e lançam erro explicando o que
// precisa ser reescrito naquele módulo, em vez de falhar silenciosamente.

type Row = Record<string, unknown>;

const SQLITE_ONLY_PATTERN =
  /\bPRAGMA\b|\bstrftime\s*\(|\bjulianday\s*\(|\bAUTOINCREMENT\b|\bINSERT\s+OR\s+(IGNORE|REPLACE)\b|\bGLOB\b/i;

function assertPortable(queryText: string) {
  const match = queryText.match(SQLITE_ONLY_PATTERN);
  if (match) {
    throw new Error(
      `Query usa sintaxe exclusiva do SQLite ("${match[0]}") e ainda não foi ` +
        `adaptada para Postgres. Ajuste o SQL neste módulo antes de rodar contra ` +
        `o Supabase. Query: ${queryText.slice(0, 200)}`,
    );
  }
}

// Converte placeholders no estilo D1/SQLite (`?` sequencial ou `?1`, `?2`
// explícitos) para o estilo Postgres (`$1`, `$2`, ...). Assume que uma
// mesma query não mistura os dois estilos (não ocorre neste projeto).
function toPgPlaceholders(queryText: string): string {
  let sequential = 0;
  return queryText.replace(/\?(\d*)/g, (_match, explicitNum: string) => {
    if (explicitNum) return `$${explicitNum}`;
    sequential += 1;
    return `$${sequential}`;
  });
}

// Identificadores não citados são normalizados para minúsculas pelo
// Postgres (diferente do SQLite, que preserva a grafia como escrita). Como
// o projeto inteiro usa `AS someCamelCaseAlias` esperando receber de volta
// `row.someCamelCaseAlias`, isso quebraria silenciosamente quase toda
// query (ex.: `AS updatedAt` viraria a chave `updatedat`). Em vez de
// revisar centenas de aliases manualmente, citamos automaticamente todo
// alias `AS xyz` que contenha letra maiúscula, preservando a grafia
// original.
function quoteCamelCaseAliases(queryText: string): string {
  return queryText.replace(
    /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    (full: string, identifier: string) => (/[A-Z]/.test(identifier) ? `AS "${identifier}"` : full),
  );
}

class PgPreparedStatement {
  constructor(
    private readonly sql: ReturnType<typeof postgres>,
    private readonly originalQuery: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): PgPreparedStatement {
    return new PgPreparedStatement(this.sql, this.originalQuery, values);
  }

  /** Só para uso interno do PgD1Compat.batch(). */
  toPgQuery(): { query: string; params: unknown[] } {
    assertPortable(this.originalQuery);
    const query = toPgPlaceholders(quoteCamelCaseAliases(this.originalQuery));
    return { query, params: this.params };
  }

  private async execute(): Promise<Row[]> {
    const { query, params } = this.toPgQuery();
    const rows = await this.sql.unsafe(query, params as never[]);
    return rows as unknown as Row[];
  }

  async run<T = Row>(): Promise<{
    success: true;
    results: T[];
    meta: { changes: number; last_row_id: number; duration: number };
  }> {
    const rows = await this.execute();
    return {
      success: true,
      results: rows as unknown as T[],
      meta: { changes: rows.length, last_row_id: 0, duration: 0 },
    };
  }

  async all<T = Row>(): Promise<{ success: true; results: T[]; meta: Record<string, never> }> {
    const rows = await this.execute();
    return { success: true, results: rows as unknown as T[], meta: {} };
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const rows = await this.execute();
    if (!rows.length) return null;
    const row = rows[0];
    return (column ? (row[column] as T) : (row as unknown as T)) ?? null;
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = await this.execute();
    return rows.map((row) => Object.values(row)) as unknown as T[];
  }
}

class PgD1Compat {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  prepare(query: string): PgPreparedStatement {
    return new PgPreparedStatement(this.sql, query);
  }

  async batch<T = Row>(statements: PgPreparedStatement[]) {
    return this.sql.begin(async (tx) => {
      const out: Array<{ success: true; results: T[]; meta: Record<string, never> }> = [];
      for (const statement of statements) {
        const { query, params } = statement.toPgQuery();
        const rows = await tx.unsafe(query, params as never[]);
        out.push({ success: true, results: rows as unknown as T[], meta: {} });
      }
      return out;
    });
  }

  async exec(query: string) {
    assertPortable(query);
    await this.sql.unsafe(query);
    return { count: 0, duration: 0 };
  }
}

export function createD1CompatFromPg(sql: ReturnType<typeof postgres>) {
  return new PgD1Compat(sql);
}
