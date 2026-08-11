declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    // Sem binding real em producao (banco D1 descartado na Fase 2) - o
    // worker/index.ts substitui `env.DB` pelo adapter Postgres antes de
    // qualquer uso (ver fetch() em worker/index.ts), entao continua sempre
    // presente em runtime. No dev local (`pnpm dev`) e o binding real do D1
    // de teste, via vite.config.ts + .openai/hosting.json.
    DB: D1Database;
    UPLOADS: R2Bucket;
    HYPERDRIVE?: Hyperdrive;
    APP_LOGIN_USER?: string;
    APP_LOGIN_PASSWORD?: string;
    APP_SESSION_SECRET?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
    IMAGES: {
      input(stream: ReadableStream): {
        transform(options: Record<string, unknown>): {
          output(options: {
            format: string;
            quality: number;
          }): Promise<{ response(): Response }>;
        };
      };
    };
  }
}

type Env = Cloudflare.Env;
