import postgres from "postgres";

// Client Postgres (Supabase) usado como substituto do binding D1.
//
// Por quê `postgres` (postgres-js) e não `@supabase/supabase-js`:
// o app inteiro faz SQL cru (env.DB.prepare(sql).bind(...).run()/.all()/
// .first()), não usa um query builder em runtime. O supabase-js client
// padrão fala com o PostgREST (API REST sobre as tabelas) e não expõe
// "rode este SQL arbitrário" — trocar por ele exigiria reescrever cada
// query como chamadas .from().select()/.insert()/etc, o que é exatamente
// o retrabalho de alto risco que este plano tenta evitar. `postgres-js` é
// um driver Postgres puro-TCP que aceita SQL parametrizado diretamente,
// compatível com Cloudflare Workers (nodejs_compat + TCP sockets) e é o
// driver que o próprio drizzle-orm usa para Postgres (drizzle-orm/postgres-js),
// então o mesmo client serve tanto para o adapter de compatibilidade D1
// (db/d1-compat.ts) quanto para uso futuro do drizzle como query builder.
//
// Use a connection string do "Transaction pooler" do Supabase (porta 6543),
// não a conexão direta (porta 5432) — Workers abrem/fecham conexões por
// requisição e o pooler em modo transaction é feito pra isso. Nesse modo o
// pgbouncer não suporta prepared statements no protocolo estendido, por
// isso `prepare: false` abaixo.

let cachedClient: ReturnType<typeof postgres> | undefined;

export function getSql(): ReturnType<typeof postgres> {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      "SUPABASE_DB_URL não está definida. Configure a connection string do " +
        "Supabase (Transaction pooler, porta 6543) nas variáveis de ambiente " +
        "antes de usar o client Postgres.",
    );
  }

  cachedClient = postgres(url, {
    prepare: false,
    ssl: "require",
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return cachedClient;
}
