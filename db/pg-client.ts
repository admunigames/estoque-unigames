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
// Conectar via TCP cru (cloudflare:sockets) direto no Supabase a partir de
// um Worker esbarra no limite de subrequests por invocação — cada
// connect()/round-trip do protocolo Postgres é contado, e uma única
// requisição que abre a conexão e roda poucas queries já estoura o limite.
// Por isso o client passa pelo Hyperdrive (binding HYPERDRIVE, ver
// wrangler.jsonc) sempre que disponível: ele mantém o pool de conexões do
// lado da Cloudflare e expõe uma connection string local ao Worker, sem
// contar como subrequests. Fora do runtime Workers (scripts locais, testes
// em Node) cai para SUPABASE_DB_URL, conectando direto no Supabase — nesse
// caso use a connection string do "Session pooler" (porta 5432).

let cachedClient: ReturnType<typeof postgres> | undefined;

async function resolveConnectionString(): Promise<{ url: string; viaHyperdrive: boolean }> {
  try {
    const { env } = await import("cloudflare:workers");
    const hyperdrive = (env as { HYPERDRIVE?: { connectionString: string } }).HYPERDRIVE;
    if (hyperdrive?.connectionString) {
      return { url: hyperdrive.connectionString, viaHyperdrive: true };
    }
  } catch {
    // Fora do runtime Workers (ex.: scripts locais/testes em Node) — segue
    // para o fallback com SUPABASE_DB_URL abaixo.
  }

  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      "Nem o binding HYPERDRIVE nem SUPABASE_DB_URL estão disponíveis. " +
        "Configure o binding no wrangler.jsonc (produção/preview) ou a " +
        "variável de ambiente SUPABASE_DB_URL (scripts/testes locais) " +
        "antes de usar o client Postgres.",
    );
  }
  return { url, viaHyperdrive: false };
}

export async function getSql(): Promise<ReturnType<typeof postgres>> {
  if (cachedClient) return cachedClient;

  const { url, viaHyperdrive } = await resolveConnectionString();
  cachedClient = postgres(url, {
    prepare: false,
    // O Hyperdrive já cuida do TLS até o Supabase; a conexão do Worker até
    // o Hyperdrive não usa/exige SSL. No fallback direto (Node local),
    // mantém SSL exigido.
    ssl: viaHyperdrive ? undefined : "require",
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      // COUNT()/SUM() retornam bigint (OID 20) no Postgres. Por padrão o
      // postgres-js devolve isso como string, pra evitar perda de precisão
      // em valores fora do intervalo seguro de um `number`. Neste projeto
      // os únicos bigints são resultados de agregação em queries de
      // contagem (nunca IDs, que são sempre `text`/UUID), então convertê-los
      // para number é seguro e evita quebrar código que espera um number
      // (como no SQLite/D1, onde COUNT/SUM já vinham como number).
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
  return cachedClient;
}
