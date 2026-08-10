import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    // Usada apenas por comandos drizzle-kit (generate/migrate/studio) rodados
    // localmente. Aponte para a connection string do Supabase via .env
    // (ver .env.example) — nunca hardcode aqui.
    url: process.env.SUPABASE_DB_URL ?? "",
  },
});

