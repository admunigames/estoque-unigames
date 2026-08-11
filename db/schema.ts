import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

// NOTA (migração D1 -> Supabase/Postgres): os tipos de coluna foram mantidos
// o mais próximo possível do schema SQLite original (text/integer, sem
// boolean/timestamp nativos do Postgres) de propósito. O código da aplicação
// não usa este arquivo como query builder em runtime — ele faz SQL cru via
// env.DB.prepare(...)/o novo client Postgres, então trocar tipos aqui (ex.
// integer 0/1 -> boolean nativo) quebraria essas queries até cada uma ser
// revisada. Ajustes de tipo devem ser feitos módulo a módulo, junto da
// reescrita/auditoria do SQL daquele módulo, não nesta conversão inicial.

export const sharedState = pgTable("shared_state", {
  key: text("state_key").primaryKey(),
  value: text("value_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`now()::text`),
});

export const appUsers = pgTable("app_users", {
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
  active: integer("active").notNull().default(1),
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`now()::text`),
  updatedAt: text("updated_at").notNull().default(sql`now()::text`),
});

export const passwordResetRequests = pgTable(
  "password_reset_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status").notNull().default("pending"),
    requestedAt: text("requested_at").notNull().default(sql`now()::text`),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    index("password_reset_requests_user_status_idx").on(table.userId, table.status),
  ],
);

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id").primaryKey(),
  theme: text("theme").notNull().default("dark"),
  accentColor: text("accent_color").notNull().default("#4f86bd"),
  logoDataUrl: text("logo_data_url").notNull().default(""),
  compactMobile: integer("compact_mobile").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`now()::text`),
});

export const purchaseDeliveryRecords = pgTable(
  "purchase_delivery_records",
  {
    id: text("id").primaryKey(),
    purchaseId: text("purchase_id").notNull(),
    deliveredAt: text("delivered_at").notNull(),
    percentage: integer("percentage").notNull().default(0),
    quantityNote: text("quantity_note").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("purchase_delivery_records_purchase_idx").on(table.purchaseId, table.deliveredAt),
  ],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)],
);

export const pushDeliveryLog = pgTable(
  "push_delivery_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    taskKey: text("task_key").notNull(),
    taskId: text("task_id").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
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

export const missions = pgTable(
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
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
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

export const missionCompletions = pgTable(
  "mission_completions",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id").notNull(),
    occurrenceDate: text("occurrence_date").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    completedBy: text("completed_by").notNull(),
    completedByName: text("completed_by_name").notNull().default(""),
    completedAt: text("completed_at").notNull().default(sql`now()::text`),
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

export const instructions = pgTable(
  "instructions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    dueDate: text("due_date").notNull(),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("instructions_due_date_created_idx").on(table.dueDate, table.createdAt),
  ],
);

export const capturedProducts = pgTable(
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
    capturedValueCents: integer("captured_value_cents").notNull().default(0),
    photoKey: text("photo_key").notNull().default(""),
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
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("captured_products_status_updated_idx").on(table.status, table.updatedAt),
    index("captured_products_origin_created_idx").on(
      table.originCompanyId,
      table.createdAt,
    ),
  ],
);

export const defectiveOutputs = pgTable(
  "defective_outputs",
  {
    id: text("id").primaryKey(),
    quantity: integer("quantity").notNull(),
    productName: text("product_name").notNull(),
    defect: text("defect").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    status: text("status").notNull().default("requested"),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    completedBy: text("completed_by").notNull().default(""),
    completedByName: text("completed_by_name").notNull().default(""),
    completedAt: text("completed_at").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("defective_outputs_status_created_idx").on(table.status, table.createdAt),
    index("defective_outputs_company_created_idx").on(table.companyId, table.createdAt),
  ],
);

export const supplyItems = pgTable(
  "supply_items",
  {
    id: text("id").primaryKey(),
    productName: text("product_name").notNull(),
    quantityText: text("quantity_text").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    status: text("status").notNull().default("pending"),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    receivedBy: text("received_by").notNull().default(""),
    receivedByName: text("received_by_name").notNull().default(""),
    receivedAt: text("received_at").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("supply_items_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    index("supply_items_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

export const supplyRequestEvents = pgTable(
  "supply_request_events",
  {
    id: text("id").primaryKey(),
    supplyItemId: text("supply_item_id").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    requestDate: text("request_date").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedByName: text("requested_by_name").notNull().default(""),
    requestedAt: text("requested_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    uniqueIndex("supply_request_events_item_date_unique").on(
      table.supplyItemId,
      table.requestDate,
    ),
    index("supply_request_events_company_date_idx").on(
      table.companyId,
      table.requestDate,
    ),
    index("supply_request_events_item_requested_idx").on(
      table.supplyItemId,
      table.requestedAt,
    ),
  ],
);
