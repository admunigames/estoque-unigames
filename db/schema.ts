import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sharedState = sqliteTable("shared_state", {
  key: text("state_key").primaryKey(),
  value: text("value_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const appUsers = sqliteTable("app_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  role: text("role").notNull().default("user"),
  accessGroup: text("access_group").notNull().default("operator"),
  permissions: text("permissions_json").notNull().default("[]"),
  companyId: text("company_id").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const passwordResetRequests = sqliteTable(
  "password_reset_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status").notNull().default("pending"),
    requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    index("password_reset_requests_user_status_idx").on(table.userId, table.status),
  ],
);

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").primaryKey(),
  theme: text("theme").notNull().default("dark"),
  accentColor: text("accent_color").notNull().default("#4f86bd"),
  logoDataUrl: text("logo_data_url").notNull().default(""),
  compactMobile: integer("compact_mobile", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const purchaseDeliveryRecords = sqliteTable(
  "purchase_delivery_records",
  {
    id: text("id").primaryKey(),
    purchaseId: text("purchase_id").notNull(),
    deliveredAt: text("delivered_at").notNull(),
    percentage: integer("percentage").notNull().default(0),
    quantityNote: text("quantity_note").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("purchase_delivery_records_purchase_idx").on(table.purchaseId, table.deliveredAt),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)],
);

export const pushDeliveryLog = sqliteTable(
  "push_delivery_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    taskKey: text("task_key").notNull(),
    taskId: text("task_id").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("push_delivery_log_task_unique").on(
      table.userId,
      table.taskKey,
      table.taskId,
      table.scheduledFor,
    ),
  ],
);

export const missions = sqliteTable(
  "missions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    scope: text("scope").notNull().default("store"),
    companyId: text("company_id").notNull().default(""),
    companyName: text("company_name").notNull().default(""),
    frequency: text("frequency").notNull().default("once"),
    startDate: text("start_date").notNull(),
    dueTime: text("due_time").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("missions_scope_company_date_idx").on(
      table.scope,
      table.companyId,
      table.startDate,
    ),
    index("missions_created_by_idx").on(table.createdBy),
  ],
);

export const missionCompletions = sqliteTable(
  "mission_completions",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id").notNull(),
    occurrenceDate: text("occurrence_date").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    completedBy: text("completed_by").notNull(),
    completedByName: text("completed_by_name").notNull().default(""),
    completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    status: text("status").notNull().default("completed"),
    updatedAt: text("updated_at").notNull().default(""),
  },
  (table) => [
    uniqueIndex("mission_completions_occurrence_unique").on(
      table.missionId,
      table.occurrenceDate,
      table.companyId,
    ),
    index("mission_completions_date_company_idx").on(
      table.occurrenceDate,
      table.companyId,
    ),
  ],
);

export const instructions = sqliteTable(
  "instructions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    dueDate: text("due_date").notNull(),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("instructions_due_date_created_idx").on(table.dueDate, table.createdAt),
  ],
);

export const capturedProducts = sqliteTable(
  "captured_products",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    productName: text("product_name").notNull(),
    serialNumber: text("serial_number").notNull(),
    defects: text("defects").notNull(),
    color: text("color").notNull(),
    originCompanyId: text("origin_company_id").notNull(),
    originCompanyName: text("origin_company_name").notNull().default(""),
    status: text("status").notNull().default("submitted"),
    destinationCompanyId: text("destination_company_id").notNull().default(""),
    destinationCompanyName: text("destination_company_name").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    receivedBy: text("received_by").notNull().default(""),
    receivedByName: text("received_by_name").notNull().default(""),
    receivedAt: text("received_at").notNull().default(""),
    readyBy: text("ready_by").notNull().default(""),
    readyByName: text("ready_by_name").notNull().default(""),
    readyAt: text("ready_at").notNull().default(""),
    assignedBy: text("assigned_by").notNull().default(""),
    assignedByName: text("assigned_by_name").notNull().default(""),
    assignedAt: text("assigned_at").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("captured_products_status_updated_idx").on(table.status, table.updatedAt),
    index("captured_products_origin_created_idx").on(
      table.originCompanyId,
      table.createdAt,
    ),
  ],
);
