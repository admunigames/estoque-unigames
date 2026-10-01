import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  // Limitado a data mais nova suportada pelo workerd fixado no lockfile.
  compatibility_date: "2026-05-22",
  compatibility_flags: ["nodejs_compat_v2"],
  vars: {
    DB_DRIVER: "d1",
    ...(process.env.APP_SESSION_SECRET
      ? { APP_SESSION_SECRET: process.env.APP_SESSION_SECRET }
      : {}),
    ...(process.env.APP_LOGIN_USER
      ? { APP_LOGIN_USER: process.env.APP_LOGIN_USER }
      : {}),
    ...(process.env.APP_LOGIN_PASSWORD
      ? { APP_LOGIN_PASSWORD: process.env.APP_LOGIN_PASSWORD }
      : {}),
  },
  assets: {
    binding: "ASSETS",
    run_worker_first: true,
  },
  triggers: {
    crons: ["* * * * *"],
  },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

function withSslModeRequire(connectionString: string): string {
  const url = new URL(connectionString);
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  return url.toString();
}

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  // So no `pnpm dev` (nunca no build) e com DB_DRIVER=postgres: emula o
  // Hyperdrive de producao. O proxy do Miniflare (em Node) abre o TLS ate o
  // Supabase e entrega ao Worker uma conexao local sem TLS. Conectar direto
  // do workerd com SSL nao funciona (o handshake TLS com o pooler do
  // Supabase trava/falha dentro do workerd).
  const env = { ...loadEnv("development", process.cwd(), ""), ...process.env };
  const localHyperdrive =
    command === "serve" && env.DB_DRIVER === "postgres" && env.SUPABASE_DB_URL
      ? [
          {
            binding: "HYPERDRIVE",
            id: "local-supabase",
            localConnectionString: withSslModeRequire(env.SUPABASE_DB_URL),
          },
        ]
      : [];

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: (productionConfig) => {
          // Nunca abre o Hyperdrive de producao no dev; usa o emulado acima.
          productionConfig.hyperdrive = [];
          return { ...localBindingConfig, hyperdrive: localHyperdrive };
        },
      }),
    ],
  };
});
