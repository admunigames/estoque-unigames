import * as schema from "./schema";

// Ponto único de acesso ao banco. Durante a migração para Supabase, o
// driver é escolhido pela env var DB_DRIVER:
//   - "d1" (padrão / produção atual): usa o binding nativo do Cloudflare D1.
//   - "postgres": usa o client Postgres (Supabase) por trás de um adapter
//     compatível com a API do D1 (prepare/bind/run/all/first/batch), para
//     que os call sites existentes não precisem mudar de forma. Ver
//     db/d1-compat.ts e db/pg-client.ts.
//
// Isso permite testar cada módulo contra o Supabase (setando
// DB_DRIVER=postgres localmente) sem afetar a produção, que continua em
// D1 até a migração ser validada e concluída.

export async function getD1(): Promise<D1Database> {
  if (process.env.DB_DRIVER === "postgres") {
    const [{ createD1CompatFromPg }, { getSql }] = await Promise.all([
      import("./d1-compat"),
      import("./pg-client"),
    ]);
    return createD1CompatFromPg(await getSql()) as unknown as D1Database;
  }

  const { env } = await import("cloudflare:workers");
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return env.DB;
}

export async function getDb() {
  if (process.env.DB_DRIVER === "postgres") {
    const [{ drizzle }, { getSql }] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("./pg-client"),
    ]);
    return drizzle(await getSql(), { schema });
  }

  const [{ drizzle }, database] = await Promise.all([
    import("drizzle-orm/d1"),
    getD1(),
  ]);
  return drizzle(database, { schema });
}

