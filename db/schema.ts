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
  hierarchy: text("hierarchy").notNull().default("administrative"),
  sector: text("sector").notNull().default(""),
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

export const operationalRoutines = pgTable(
  "operational_routines",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    // Descrição, destino por loja e escopo (geral/loja) não são mais
    // usados pela aplicação — rotina é sempre geral para todas as lojas.
    // Colunas mantidas sem uso para não descartar dados já cadastrados.
    description: text("description").notNull().default(""),
    scope: text("scope").notNull().default("general"),
    companyId: text("company_id").notNull().default(""),
    companyName: text("company_name").notNull().default(""),
    // Dias da semana em que a rotina se repete, formato "1,3,5" (0=domingo).
    weekdays: text("weekdays").notNull().default(""),
    active: integer("active").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("operational_routines_created_by_idx").on(table.createdBy),
  ],
);

export const operationalRoutineTasks = pgTable(
  "operational_routine_tasks",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    originDate: text("origin_date").notNull(),
    dueDate: text("due_date").notNull(),
    status: text("status").notNull().default("todo"),
    completedBy: text("completed_by").notNull().default(""),
    completedByName: text("completed_by_name").notNull().default(""),
    completedAt: text("completed_at").notNull().default(""),
    carriedOver: integer("carried_over").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(""),
  },
  (table) => [
    uniqueIndex("operational_routine_tasks_origin_unique").on(
      table.routineId,
      table.originDate,
      table.companyId,
    ),
    index("operational_routine_tasks_due_company_idx").on(
      table.dueDate,
      table.companyId,
    ),
  ],
);

// Checklists diárias fixas (Check-in, Check-out, Troca de Turno) do módulo
// Missões. Os itens de cada checklist são constantes no código (não
// cadastráveis), então só existe linha aqui para o que já foi marcado como
// concluído — item sem linha é considerado não feito. Reinicia sozinho todo
// dia porque a chave inclui a data.
export const dailyChecklistItems = pgTable(
  "daily_checklist_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    itemKey: text("item_key").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    date: text("date").notNull(),
    completed: integer("completed").notNull().default(0),
    completedBy: text("completed_by").notNull().default(""),
    completedByName: text("completed_by_name").notNull().default(""),
    completedAt: text("completed_at").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    uniqueIndex("daily_checklist_items_unique").on(
      table.kind,
      table.itemKey,
      table.companyId,
      table.date,
    ),
    index("daily_checklist_items_date_company_idx").on(table.date, table.companyId),
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

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    category: text("category").notNull(),
    folder: text("folder").notNull(),
    subfolder: text("subfolder").notNull().default(""),
    r2Key: text("r2_key").notNull().unique(),
    contentType: text("content_type").notNull().default("application/pdf"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedByName: text("uploaded_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("documents_folder_created_idx").on(
      table.folder,
      table.subfolder,
      table.createdAt,
    ),
    index("documents_uploaded_by_idx").on(table.uploadedBy),
  ],
);

export const capturedProducts = pgTable(
  "captured_products",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    productName: text("product_name").notNull(),
    gameName: text("game_name").notNull().default(""),
    gameConsole: text("game_console").notNull().default(""),
    gameCondition: text("game_condition").notNull().default(""),
    serialNumber: text("serial_number").notNull(),
    defects: text("defects").notNull(),
    color: text("color").notNull(),
    originCompanyId: text("origin_company_id").notNull(),
    originCompanyName: text("origin_company_name").notNull().default(""),
    capturedValueCents: integer("captured_value_cents").notNull().default(0),
    photoKey: text("photo_key").notNull().default(""),
    parentCaptureId: text("parent_capture_id").notNull().default(""),
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
    index("captured_products_parent_idx").on(table.parentCaptureId),
  ],
);

export const defectiveOutputs = pgTable(
  "defective_outputs",
  {
    id: text("id").primaryKey(),
    quantity: integer("quantity").notNull(),
    productName: text("product_name").notNull(),
    responsibleName: text("responsible_name").notNull().default(""),
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

export const requestedInputs = pgTable(
  "requested_inputs",
  {
    id: text("id").primaryKey(),
    quantity: integer("quantity").notNull(),
    productName: text("product_name").notNull(),
    responsibleName: text("responsible_name").notNull().default(""),
    reason: text("reason").notNull(),
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
    index("requested_inputs_status_created_idx").on(table.status, table.createdAt),
    index("requested_inputs_company_created_idx").on(table.companyId, table.createdAt),
  ],
);

export const supplyCategories = pgTable("supply_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`now()::text`),
  updatedAt: text("updated_at").notNull().default(sql`now()::text`),
});

export const supplyProducts = pgTable(
  "supply_products",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id").notNull(),
    name: text("name").notNull(),
    active: integer("active").notNull().default(1),
    notes: text("notes").notNull().default(""),
    stockQty: integer("stock_qty").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("supply_products_category_idx").on(table.categoryId, table.name),
    index("supply_products_active_idx").on(table.active),
  ],
);

export const supplyStockMovements = pgTable(
  "supply_stock_movements",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    type: text("type").notNull(),
    quantity: integer("quantity").notNull(),
    reason: text("reason").notNull().default(""),
    responsibleName: text("responsible_name").notNull().default(""),
    companyId: text("company_id").notNull().default(""),
    companyName: text("company_name").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("supply_stock_movements_product_created_idx").on(
      table.productId,
      table.createdAt,
    ),
    index("supply_stock_movements_company_idx").on(table.companyId),
  ],
);

export const supplyMissingMarks = pgTable(
  "supply_missing_marks",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    weekStart: text("week_start").notNull(),
    markedBy: text("marked_by").notNull(),
    markedByName: text("marked_by_name").notNull().default(""),
    markedAt: text("marked_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    uniqueIndex("supply_missing_marks_unique").on(
      table.productId,
      table.companyId,
      table.weekStart,
    ),
    index("supply_missing_marks_company_week_idx").on(
      table.companyId,
      table.weekStart,
    ),
  ],
);

export const supplyRequests = pgTable(
  "supply_requests",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    weekStart: text("week_start").notNull(),
    responsibleName: text("responsible_name").notNull().default(""),
    note: text("note").notNull().default(""),
    status: text("status").notNull().default("submitted"),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    uniqueIndex("supply_requests_company_week_unique").on(
      table.companyId,
      table.weekStart,
    ),
  ],
);

export const supplyRequestItems = pgTable(
  "supply_request_items",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    productId: text("product_id").notNull(),
    productName: text("product_name").notNull(),
    categoryName: text("category_name").notNull().default(""),
    quantity: integer("quantity").notNull(),
    quantitySeparated: integer("quantity_separated").notNull().default(0),
    separated: integer("separated").notNull().default(0),
    separatedBy: text("separated_by").notNull().default(""),
    separatedByName: text("separated_by_name").notNull().default(""),
    separatedAt: text("separated_at").notNull().default(""),
    // 'separated' | 'not_sent' — só relevante quando separated=1;
    // diferencia um item de fato separado de um que o responsável
    // marcou explicitamente como não enviado (com motivo obrigatório).
    separationStatus: text("separation_status").notNull().default("separated"),
    // Motivo do separador quando o item não veio completo/não veio —
    // preenchido junto da separação, distinto da observação única da
    // solicitação inteira.
    separationNote: text("separation_note").notNull().default(""),
    // 'pending' | 'received' | 'not_received' — a loja confirma o que
    // chegou; "not_received" é uma confirmação explícita de que não
    // chegou, diferente de "pending" (ainda não confirmado).
    receivedStatus: text("received_status").notNull().default("pending"),
    receivedBy: text("received_by").notNull().default(""),
    receivedByName: text("received_by_name").notNull().default(""),
    receivedAt: text("received_at").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [index("supply_request_items_request_idx").on(table.requestId)],
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

export const pdvChangeRequests = pgTable(
  "pdv_change_requests",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    saleId: text("sale_id").notNull(),
    requesterName: text("requester_name").notNull().default(""),
    detailsJson: text("details_json").notNull().default("{}"),
    status: text("status").notNull().default("open"),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("pdv_change_requests_sale_idx").on(table.saleId),
    index("pdv_change_requests_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const osNotes = pgTable(
  "os_notes",
  {
    id: text("id").primaryKey(),
    osId: text("os_id").notNull(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    requesterName: text("requester_name").notNull().default(""),
    status: text("status").notNull().default("pending"),
    fileName: text("file_name").notNull().default(""),
    r2Key: text("r2_key").notNull().default(""),
    sizeBytes: integer("size_bytes").notNull().default(0),
    attachedBy: text("attached_by").notNull().default(""),
    attachedByName: text("attached_by_name").notNull().default(""),
    attachedAt: text("attached_at").notNull().default(""),
    fileRemovedAt: text("file_removed_at").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("os_notes_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    index("os_notes_os_id_idx").on(table.osId),
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

export const financeCategories = pgTable(
  "finance_categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [index("finance_categories_parent_idx").on(table.parentId)],
);

export const financeItems = pgTable(
  "finance_items",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [index("finance_items_category_idx").on(table.categoryId)],
);

export const financeStoreEntries = pgTable(
  "finance_store_entries",
  {
    id: text("id").primaryKey(),
    storeId: text("store_id").notNull(),
    itemId: text("item_id").notNull(),
    month: text("month").notNull(),
    entryType: text("entry_type").notNull(),
    amountCents: integer("amount_cents"),
    percentBasisPoints: integer("percent_basis_points"),
    // Origem do lançamento: 'manual' (digitado por quem cadastra a DRE) ou
    // 'payable' (soma de accounts_payable.original_amount_cents de todas
    // as contas não canceladas daquele store+item+month — ver
    // app/api/finance/payables/shared.ts#recalcPayableEntry). Uma célula
    // 'payable' nunca convive com uma manual (bloqueado na escrita), mas
    // várias contas a pagar podem somar na mesma célula 'payable' (ex.:
    // recorrência semanal cai toda no mesmo mês de competência, ou duas
    // notas fiscais diferentes do mesmo item/loja/mês) — por isso não há
    // FK 1:1 pra uma conta específica aqui; a rastreabilidade é feita
    // consultando accounts_payable por company_id+finance_item_id+
    // competence_month.
    source: text("source").notNull().default("manual"),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    uniqueIndex("finance_store_entries_store_item_month_idx").on(
      table.storeId,
      table.itemId,
      table.month,
    ),
    index("finance_store_entries_store_month_idx").on(table.storeId, table.month),
  ],
);

export const financeSuppliers = pgTable(
  "finance_suppliers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    document: text("document").notNull().default(""),
    notes: text("notes").notNull().default(""),
    active: integer("active").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("finance_suppliers_active_name_idx").on(table.active, table.name),
  ],
);

// Conta bancária/financeira. Igual a finance_categories/finance_items,
// não tinha empresa/loja nem os campos bancários no lançamento original —
// esta é a extensão pra um cadastro completo (ver migration 0029).
// company_id fica NOT NULL DEFAULT '' (não um NOT NULL puro) porque já
// havia contas cadastradas em produção sem loja antes desta migration;
// a obrigatoriedade de verdade é aplicada na validação da rota de escrita,
// mesmo padrão do resto do projeto (texto vazio como sentinela, não NULL).
export const financeAccounts = pgTable(
  "finance_accounts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull().default(""),
    companyName: text("company_name").notNull().default(""),
    name: text("name").notNull(),
    // 'checking' | 'savings' | 'cash' | 'wallet' | 'digital' | 'card' | 'investment' | 'other'
    type: text("type").notNull().default("checking"),
    bankName: text("bank_name").notNull().default(""),
    bankCode: text("bank_code").notNull().default(""),
    agency: text("agency").notNull().default(""),
    agencyDigit: text("agency_digit").notNull().default(""),
    accountNumber: text("account_number").notNull().default(""),
    accountDigit: text("account_digit").notNull().default(""),
    holderName: text("holder_name").notNull().default(""),
    holderDocument: text("holder_document").notNull().default(""),
    // 'cpf' | 'cnpj' | 'email' | 'phone' | 'random' | ''
    pixKeyType: text("pix_key_type").notNull().default(""),
    pixKey: text("pix_key").notNull().default(""),
    openingBalanceCents: integer("opening_balance_cents").notNull().default(0),
    openingBalanceDate: text("opening_balance_date").notNull().default(""),
    notes: text("notes").notNull().default(""),
    active: integer("active").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("finance_accounts_active_name_idx").on(table.active, table.name),
    index("finance_accounts_company_active_idx").on(table.companyId, table.active),
  ],
);

// Obrigação financeira (contas a pagar). Cada parcela/ocorrência de
// recorrência é sua própria linha (com competenceMonth própria), agrupada
// por installmentGroupId/recurrenceId — não existe um registro "pai"
// separado. Ver [[estoque_modulo_financeiro_dre]] para a regra de
// competência que rege quando o lançamento em finance_store_entries é
// criado/atualizado/removido a partir daqui.
export const accountsPayable = pgTable(
  "accounts_payable",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    description: text("description").notNull(),
    supplierId: text("supplier_id").notNull().default(""),
    financeItemId: text("finance_item_id").notNull(),
    financeAccountId: text("finance_account_id").notNull().default(""),
    originalAmountCents: integer("original_amount_cents").notNull(),
    paidAmountCents: integer("paid_amount_cents").notNull().default(0),
    issueDate: text("issue_date").notNull().default(""),
    competenceMonth: text("competence_month").notNull(),
    dueDate: text("due_date").notNull(),
    paymentMethod: text("payment_method").notNull().default(""),
    invoiceNumber: text("invoice_number").notNull().default(""),
    orderReference: text("order_reference").notNull().default(""),
    billingCode: text("billing_code").notNull().default(""),
    notes: text("notes").notNull().default(""),
    // 'open' | 'scheduled' | 'partially_paid' | 'paid' | 'canceled'.
    // Os estados derivados de data (vencido/vencendo hoje/a vencer) NÃO são
    // armazenados — calculados em app/lib/finance-status.ts a partir de
    // dueDate+saldo, pra nunca divergir do que está no banco.
    status: text("status").notNull().default("open"),
    recurrenceId: text("recurrence_id"),
    recurrenceFrequency: text("recurrence_frequency").notNull().default(""),
    recurrenceOccurrenceIndex: integer("recurrence_occurrence_index").notNull().default(0),
    recurrenceOccurrenceCount: integer("recurrence_occurrence_count"),
    recurrenceEndDate: text("recurrence_end_date").notNull().default(""),
    installmentGroupId: text("installment_group_id"),
    installmentNumber: integer("installment_number").notNull().default(0),
    installmentTotal: integer("installment_total").notNull().default(0),
    financeEntryId: text("finance_entry_id").notNull().default(""),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
    canceledBy: text("canceled_by").notNull().default(""),
    canceledByName: text("canceled_by_name").notNull().default(""),
    canceledAt: text("canceled_at").notNull().default(""),
  },
  (table) => [
    index("accounts_payable_company_status_due_idx").on(
      table.companyId,
      table.status,
      table.dueDate,
    ),
    index("accounts_payable_company_competence_idx").on(
      table.companyId,
      table.competenceMonth,
    ),
    index("accounts_payable_supplier_idx").on(table.supplierId),
    index("accounts_payable_recurrence_idx").on(table.recurrenceId),
    index("accounts_payable_installment_group_idx").on(table.installmentGroupId),
    uniqueIndex("accounts_payable_idempotency_idx").on(table.idempotencyKey),
  ],
);

export const accountsPayablePayments = pgTable(
  "accounts_payable_payments",
  {
    id: text("id").primaryKey(),
    payableId: text("payable_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    paymentDate: text("payment_date").notNull(),
    paymentMethod: text("payment_method").notNull().default(""),
    financeAccountId: text("finance_account_id").notNull().default(""),
    notes: text("notes").notNull().default(""),
    scheduled: integer("scheduled").notNull().default(0),
    confirmedAt: text("confirmed_at").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    index("accounts_payable_payments_payable_idx").on(table.payableId, table.createdAt),
    uniqueIndex("accounts_payable_payments_idempotency_idx").on(table.idempotencyKey),
  ],
);

export const financeStoreRevenue = pgTable(
  "finance_store_revenue",
  {
    id: text("id").primaryKey(),
    storeId: text("store_id").notNull(),
    month: text("month").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    uniqueIndex("finance_store_revenue_store_month_idx").on(table.storeId, table.month),
  ],
);

// Módulo "Notas Fiscais e Duplicatas de Fornecedores" (Financeiro > Contas
// a Pagar, integrado a Controle de Compras). Ver [[estoque_modulo_nf_duplicatas]]
// para o desenho completo. Resumo das decisões principais:
//  - Uma NF (supplier_invoices) é o elo entre o pedido do Notion (Compras) e
//    o Financeiro. origin='purchase' quando veio de um pedido (notion_purchase_id
//    preenchido, sem FK real — mesmo padrão já usado em purchase_delivery_records)
//    ou 'manual' quando cadastrada direto no Financeiro.
//  - Cada duplicata (supplier_invoice_installments) tem sua PRÓPRIA linha em
//    accounts_payable (accounts_payable_id), reaproveitando 100% da lógica
//    de status/pagamento/DRE já existente — não existe tabela de pagamento
//    nova (accounts_payable_payments é reaproveitada por completo).
//  - Para a DRE nunca reconhecer a despesa mais de uma vez: TODAS as parcelas
//    de uma mesma NF são gravadas com o MESMO competence_month (o da NF, não
//    o vencimento de cada parcela) e o MESMO finance_item_id/company_id — o
//    mecanismo já existente (recalcPayableEntrySql, que soma por
//    company+item+competence_month) então soma exatamente o valor total da
//    NF, sem precisar de nenhum código novo de agregação nem de um novo
//    valor de `source`.
//  - due_date/original_amount_cents/paid_amount_cents/payment_method/
//    finance_account_id ficam guardados TAMBÉM na duplicata (não só na
//    accounts_payable ligada) de propósito — é uma denormalização
//    deliberada para permitir listar/filtrar duplicatas sem join, sempre
//    escrita na MESMA transação que a accounts_payable correspondente (a
//    accounts_payable é a fonte da verdade; a duplicata é um espelho).
//  - status da duplicata NUNCA é persistido (nem aqui, nem em
//    accounts_payable) — sempre calculado em app/lib/supplier-invoice-status.ts
//    a partir de paid/due/cancelado, mesmo padrão de finance-status.ts.

export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    supplierId: text("supplier_id").notNull().default(""),
    supplierDocument: text("supplier_document").notNull().default(""),
    invoiceNumber: text("invoice_number").notNull(),
    series: text("series").notNull().default(""),
    // Chave de acesso da NF-e (44 dígitos) — text para preservar zeros à
    // esquerda; vazio quando não informada (a maioria dos pedidos do Notion
    // hoje não carrega XML de NFe, ver relatório final).
    accessKey: text("access_key").notNull().default(""),
    issueDate: text("issue_date").notNull().default(""),
    entryDate: text("entry_date").notNull().default(""),
    competenceMonth: text("competence_month").notNull(),
    notionPurchaseId: text("notion_purchase_id").notNull().default(""),
    notionPurchaseUrl: text("notion_purchase_url").notNull().default(""),
    totalAmountCents: integer("total_amount_cents").notNull(),
    financeCategoryId: text("finance_category_id").notNull().default(""),
    financeItemId: text("finance_item_id").notNull().default(""),
    costCenter: text("cost_center").notNull().default(""),
    notes: text("notes").notNull().default(""),
    // 'purchase' | 'manual'
    origin: text("origin").notNull().default("manual"),
    // Espelho textual do status operacional do pedido no Notion no momento
    // do envio ao financeiro (não é a fonte da verdade — o Notion é; serve
    // só de contexto na tela do Financeiro, que não consulta o Notion ao
    // vivo). Vazio para NF manual.
    operationalStatus: text("operational_status").notNull().default(""),
    // aguardando_envio | aguardando_conferencia | aguardando_duplicatas |
    // aguardando_boletos | pronto_pagamento | parcialmente_pago | pago |
    // vencido | com_divergencia | cancelado — sempre recalculado em toda
    // escrita relevante por app/lib/supplier-invoice-status.ts, nunca
    // aceito do cliente.
    financialStatus: text("financial_status").notNull().default("aguardando_envio"),
    pendingCorrection: integer("pending_correction").notNull().default(0),
    returnReason: text("return_reason").notNull().default(""),
    canceled: integer("canceled").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    sentToFinanceBy: text("sent_to_finance_by").notNull().default(""),
    sentToFinanceByName: text("sent_to_finance_by_name").notNull().default(""),
    sentToFinanceAt: text("sent_to_finance_at").notNull().default(""),
    returnedBy: text("returned_by").notNull().default(""),
    returnedByName: text("returned_by_name").notNull().default(""),
    returnedAt: text("returned_at").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedBy: text("updated_by").notNull().default(""),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    uniqueIndex("supplier_invoices_unique_doc_idx").on(
      table.companyId,
      table.supplierId,
      table.invoiceNumber,
      table.series,
    ),
    index("supplier_invoices_company_status_idx").on(table.companyId, table.financialStatus),
    index("supplier_invoices_notion_purchase_idx").on(table.notionPurchaseId),
  ],
);

export const supplierInvoiceInstallments = pgTable(
  "supplier_invoice_installments",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").notNull(),
    companyId: text("company_id").notNull(),
    installmentNumber: integer("installment_number").notNull().default(1),
    installmentTotal: integer("installment_total").notNull().default(1),
    documentNumber: text("document_number").notNull().default(""),
    dueDate: text("due_date").notNull(),
    originalAmountCents: integer("original_amount_cents").notNull(),
    paidAmountCents: integer("paid_amount_cents").notNull().default(0),
    paymentMethod: text("payment_method").notNull().default(""),
    financeAccountId: text("finance_account_id").notNull().default(""),
    boletoCode: text("boleto_code").notNull().default(""),
    notes: text("notes").notNull().default(""),
    // Vínculo com a accounts_payable "gêmea" desta duplicata — reaproveita
    // toda a lógica de status/pagamento/DRE de lá. Nunca nulo depois de
    // criada (a criação da duplicata e da accounts_payable acontece na
    // mesma transação).
    accountsPayableId: text("accounts_payable_id").notNull().default(""),
    canceled: integer("canceled").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("supplier_invoice_installments_invoice_idx").on(table.invoiceId, table.installmentNumber),
    index("supplier_invoice_installments_payable_idx").on(table.accountsPayableId),
  ],
);

export const supplierInvoiceAttachments = pgTable(
  "supplier_invoice_attachments",
  {
    id: text("id").primaryKey(),
    // Exatamente um dos três preenchido (CHECK na migration SQL) — a
    // referência mais específica disponível no momento do upload (NF ->
    // invoice, boleto -> installment, comprovante -> payment).
    invoiceId: text("invoice_id").notNull().default(""),
    installmentId: text("installment_id").notNull().default(""),
    paymentId: text("payment_id").notNull().default(""),
    // 'nf' | 'boleto' | 'comprovante'
    attachmentType: text("attachment_type").notNull(),
    r2Key: text("r2_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull().default("application/pdf"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedByName: text("uploaded_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("supplier_invoice_attachments_invoice_idx").on(table.invoiceId),
    index("supplier_invoice_attachments_installment_idx").on(table.installmentId),
    index("supplier_invoice_attachments_payment_idx").on(table.paymentId),
  ],
);

export const supplierInvoiceEvents = pgTable(
  "supplier_invoice_events",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").notNull(),
    eventType: text("event_type").notNull(),
    description: text("description").notNull().default(""),
    metadataJson: text("metadata_json").notNull().default("{}"),
    actorId: text("actor_id").notNull().default(""),
    actorName: text("actor_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [index("supplier_invoice_events_invoice_idx").on(table.invoiceId, table.createdAt)],
);

export const loanDevices = pgTable(
  "loan_devices",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    imei: text("imei").notNull().default(""),
    hasDefect: integer("has_defect").notNull().default(0),
    defectDescription: text("defect_description").notNull().default(""),
    // Lista livre do que acompanha o aparelho (ex.: "carregador, capinha,
    // fone") — visível pra loja na listagem, pra saber o que esperar antes
    // de solicitar.
    accessories: text("accessories").notNull().default(""),
    // 'available' | 'loaned' | 'maintenance'
    status: text("status").notNull().default("available"),
    // Preenchidos automaticamente quando status='loaned', a partir da
    // solicitação aprovada; usados para calcular há quantos dias está
    // emprestado (selo de alerta) e para onde.
    currentCompanyId: text("current_company_id").notNull().default(""),
    currentCompanyName: text("current_company_name").notNull().default(""),
    loanedAt: text("loaned_at").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("loan_devices_status_idx").on(table.status),
    index("loan_devices_current_company_idx").on(table.currentCompanyId),
  ],
);

export const loanRequests = pgTable(
  "loan_requests",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name").notNull().default(""),
    companyId: text("company_id").notNull(),
    companyName: text("company_name").notNull().default(""),
    responsibleName: text("responsible_name").notNull().default(""),
    reason: text("reason").notNull().default(""),
    // 'requested' | 'loaned' | 'returned'
    status: text("status").notNull().default("requested"),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
    // Preenchidos quando o admin marca "Marcar como Emprestado" (Data da
    // Separação no print de referência).
    separatedBy: text("separated_by").notNull().default(""),
    separatedByName: text("separated_by_name").notNull().default(""),
    separatedAt: text("separated_at").notNull().default(""),
    // Preenchidos quando o admin registra o retorno do aparelho (devolvido
    // pela loja), o que também libera o aparelho para novo empréstimo.
    returnedBy: text("returned_by").notNull().default(""),
    returnedByName: text("returned_by_name").notNull().default(""),
    returnedAt: text("returned_at").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`now()::text`),
  },
  (table) => [
    index("loan_requests_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    index("loan_requests_device_idx").on(table.deviceId),
    index("loan_requests_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const loanRequestUpdates = pgTable(
  "loan_request_updates",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    message: text("message").notNull(),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`now()::text`),
  },
  (table) => [index("loan_request_updates_request_idx").on(table.requestId, table.createdAt)],
);
