import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sharedState = sqliteTable("shared_state", {
  key: text("state_key").primaryKey(),
  value: text("value_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

