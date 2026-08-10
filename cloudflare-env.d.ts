declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
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
