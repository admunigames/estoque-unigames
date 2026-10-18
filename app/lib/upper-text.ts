// CAIXA ALTA no que o usuário grava (padronização de 18/10/2026).
//
// Ponto único: getD1() (db/index.ts) embrulha o banco com withUpperText, que
// converte para maiúsculas — antes de gravar — só os parâmetros ligados às
// colunas de texto livre listadas em UPPER_TEXT_COLUMNS, em todo INSERT /
// UPDATE de qualquer rota. Assim nenhuma rota precisa lembrar de converter.
//
// FICAM DE FORA (nunca entram na lista): login/usuário, senha, tokens e
// chaves, e-mail, URL/link, chave PIX, nome/chave de arquivo (R2), fotos e
// logos, ids, códigos, status/tipos usados pelo código ("pendente",
// "5x2"…), JSON, datas, números, e dados importados de extrato/planilha
// (descrição do extrato, nome do vendedor na planilha…). A lista foi
// revisada tabela a tabela a partir do db/schema.ts: coluna nova de texto
// livre só vira maiúscula se for adicionada aqui.

export function upperText<T>(value: T): T {
  return (typeof value === "string" ? value.toLocaleUpperCase("pt-BR") : value) as T;
}

export const UPPER_TEXT_COLUMNS: Record<string, readonly string[]> = {
  app_users: ["display_name"],
  purchase_delivery_records: ["quantity_note", "notes"],
  missions: ["title", "description", "company_name", "created_by_name"],
  mission_completions: ["company_name", "completed_by_name"],
  operational_routines: ["title", "description", "company_name", "created_by_name"],
  operational_routine_tasks: ["company_name", "completed_by_name"],
  daily_checklist_items: ["company_name", "completed_by_name"],
  instructions: ["title", "description", "created_by_name"],
  instruction_carousel_images: ["created_by_name"],
  documents: ["uploaded_by_name"],
  captured_products: ["product_name", "game_name", "game_console", "game_condition", "defects", "origin_company_name", "destination_company_name", "created_by_name", "received_by_name", "ready_by_name", "assigned_by_name"],
  defective_outputs: ["product_name", "responsible_name", "defect", "company_name", "created_by_name", "completed_by_name"],
  requested_inputs: ["product_name", "responsible_name", "reason", "company_name", "created_by_name", "completed_by_name"],
  supply_categories: ["name"],
  supply_products: ["name", "notes"],
  supply_stock_movements: ["reason", "responsible_name", "company_name", "created_by_name"],
  supply_missing_marks: ["company_name", "marked_by_name"],
  supply_requests: ["company_name", "responsible_name", "note", "created_by_name"],
  supply_request_items: ["product_name", "category_name", "separated_by_name", "separation_note", "received_by_name"],
  supply_items: ["product_name", "quantity_text", "company_name", "created_by_name", "received_by_name"],
  pdv_change_requests: ["requester_name", "company_name", "created_by_name", "updated_by_name"],
  os_notes: ["company_name", "requester_name", "attached_by_name", "created_by_name", "updated_by_name"],
  supply_request_events: ["company_name", "requested_by_name"],
  finance_categories: ["name", "created_by_name"],
  finance_items: ["name", "created_by_name"],
  obras: ["company_name", "title", "description", "responsible", "notes", "created_by_name", "updated_by_name"],
  obra_entries: ["description", "supplier", "notes", "created_by_name"],
  finance_cost_centers: ["name", "created_by_name"],
  finance_budgets: ["company_name", "notes", "created_by_name", "updated_by_name"],
  finance_store_entries: ["created_by_name", "updated_by_name"],
  finance_suppliers: ["name", "notes", "created_by_name", "updated_by_name"],
  finance_accounts: ["company_name", "name", "bank_name", "holder_name", "notes", "created_by_name", "updated_by_name"],
  accounts_payable: ["company_name", "description", "notes", "cost_center", "created_by_name", "updated_by_name", "canceled_by_name"],
  accounts_payable_payments: ["notes", "created_by_name"],
  expenses: ["company_name", "description", "cost_center", "notes", "created_by_name", "updated_by_name"],
  expense_rateio_shares: ["company_name"],
  finance_rateio_model_shares: ["company_name", "updated_by_name"],
  finance_store_headcount: ["company_name", "updated_by_name"],
  expense_attachments: ["uploaded_by_name"],
  finance_store_revenue: ["created_by_name", "updated_by_name"],
  supplier_invoices: ["company_name", "cost_center", "notes", "return_reason", "created_by_name", "sent_to_finance_by_name", "returned_by_name", "updated_by_name"],
  supplier_invoice_installments: ["notes", "created_by_name"],
  supplier_invoice_attachments: ["uploaded_by_name"],
  supplier_invoice_events: ["description", "actor_name"],
  supplier_open_debts: ["company_name", "supplier_name", "description", "notes", "created_by_name", "updated_by_name"],
  accounts_payable_payment_attachments: ["created_by_name"],
  loan_devices: ["name", "defect_description", "accessories", "current_company_name", "created_by_name"],
  loan_requests: ["device_name", "company_name", "responsible_name", "reason", "created_by_name", "separated_by_name", "returned_by_name"],
  loan_request_updates: ["message", "author_name"],
  hr_employees: ["full_name", "company_name", "role_title", "bank_name", "notes", "benefit_notes", "created_by_name", "updated_by_name"],
  hr_payroll_entries: ["employee_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  hr_thirteenth_salary: ["employee_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  hr_payroll_settings: ["commission_rule_text", "updated_by_name"],
  hr_benefits: ["employee_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  hr_holidays: ["name", "company_name", "created_by_name", "updated_by_name"],
  hr_commission_presets: ["name", "created_by_name", "updated_by_name"],
  hr_commissions: ["employee_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  hr_commission_items: ["label"],
  accounts_receivable: ["company_name", "operator_text", "notes", "created_by_name", "updated_by_name", "canceled_by_name"],
  finance_account_balances: ["notes", "updated_by_name"],
  finance_account_weekly_balances: ["notes", "created_by_name", "updated_by_name"],
  finance_cash_flow_settings: ["updated_by_name"],
  finance_acquirers: ["name", "notes", "created_by_name", "updated_by_name"],
  finance_card_machines: ["acquirer_name", "model", "company_name", "notes", "created_by_name", "updated_by_name"],
  finance_card_machine_events: ["from_company_name", "to_company_name", "description", "created_by_name"],
  finance_card_fees: ["acquirer_name", "created_by_name", "updated_by_name"],
  finance_card_sales_imports: ["company_name", "created_by_name"],
  finance_card_sales: ["reviewed_by_name", "reviewed_note"],
  finance_corporate_cards: ["name", "bank", "holder_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  finance_card_invoice_imports: ["created_by_name"],
  finance_card_invoice_entries: ["holder_name", "notes", "created_by_name"],
  finance_bank_statement_imports: ["created_by_name"],
  finance_bank_statement_entries: ["sales_recon_note", "created_by_name", "updated_by_name"],
  finance_sales_recon_imports: ["created_by_name"],
  finance_sales_recon_rows: ["notes", "created_by_name", "updated_by_name"],
  finance_uber_rides: ["created_by_name"],
  finance_credit_providers: ["name", "notes", "created_by_name", "updated_by_name"],
  finance_credit_sales: ["company_name", "provider_name", "proposal", "customer_name", "notes", "created_by_name", "updated_by_name"],
  finance_bank_classification_rules: ["updated_by_name"],
  finance_replacement_entries: ["company_name", "product", "reason", "responsible_name", "notes", "created_by_name", "updated_by_name"],
  finance_phone_recharges: ["carrier", "company_name", "responsible_name", "notes", "created_by_name", "updated_by_name"],
  finance_phone_recharge_events: ["notes", "created_by_name"],
  finance_mall_declarations: ["mall_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  finance_mall_declaration_attachments: ["uploaded_by_name"],
  purchase_orders: ["company_name", "notes", "won_by_name", "created_by_name", "updated_by_name"],
  purchase_order_items: ["product_name", "notes", "created_by_name", "updated_by_name"],
  purchase_order_item_quotes: ["notes", "created_by_name", "updated_by_name"],
  purchase_order_attachments: ["uploaded_by_name"],
  product_catalog: ["name", "updated_by_name"],
  hr_leader_pdi: ["leader_name", "company_name", "topic_discussed", "suggested_activity", "management_feedback", "team_members", "created_by_name", "updated_by_name"],
  hr_time_tracking_settings: ["notes", "created_by_name", "updated_by_name"],
  hr_time_tracking_entries: ["notes", "created_by_name", "updated_by_name"],
  hr_time_tracking_payouts: ["notes", "created_by_name", "updated_by_name"],
  hr_store_tracking: ["company_name", "team_members", "management_feedback", "topic_discussed", "suggested_activity", "member_returns", "created_by_name", "updated_by_name"],
  hr_recruitment_candidates: ["full_name", "interview_result_reason", "cancelled_reason", "admission_company_name", "fixed_unit_name", "aso_clinic", "integration_meeting_transcript", "created_by_name", "updated_by_name"],
  hr_recruitment_status_history: ["note", "changed_by_name"],
  hr_recruitment_test_payments: ["note", "created_by_name"],
  hr_recruitment_sponsors: ["employee_name", "company_name", "sponsor_name", "created_by_name", "updated_by_name"],
  hr_recruitment_sponsor_updates: ["update_text", "created_by_name"],
  uniform_stock_items: ["size"],
  uniform_stock_movements: ["size", "employee_name", "company_name", "note", "created_by_name"],
  uniform_coat_terms: ["employee_name", "company_name", "size", "created_by_name", "updated_by_name"],
  hr_dental_plan: ["employee_name", "unit_name", "reason", "notes", "created_by_name", "updated_by_name"],
  hr_schedule_assignments: ["employee_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  hr_schedule_sunday_work: ["employee_name", "created_by_name", "updated_by_name"],
  hr_schedule_weekday_off: ["employee_name", "created_by_name", "updated_by_name"],
  hr_schedule_day_notes: ["company_name", "notes", "created_by_name", "updated_by_name"],
  hr_terminations: ["employee_name", "company_name", "notes", "created_by_name", "updated_by_name"],
  hr_aso_exams: ["employee_name", "company_name", "clinic_name", "notes", "created_by_name", "updated_by_name"],
  commercial_monthly: ["employee_name", "company_name", "updated_by_name"],
  commercial_rules: ["notes", "updated_by_name"],
  commercial_newcomers: ["marked_by_name"],
  commercial_credit_entries: ["employee_name", "created_by_name"],
  commercial_store_goals: ["assist_updated_by_name", "updated_by_name"],
  commercial_weekend_goals: ["updated_by_name"],
  commercial_roles: ["updated_by_name"],
  commercial_indications: ["company_name", "referrer_name", "customer", "notes", "created_by_name", "updated_by_name", "deleted_by_name"],
  commercial_imports: ["created_by_name"],
  commercial_nf_report_entries: ["store_name", "created_by_name", "updated_by_name"],
  commercial_gd_balance_adjustments: ["store_name", "seller_name", "reason", "canceled_by_name", "created_by_name", "updated_by_name"],
  commercial_gd_opening_balances: ["updated_by_name"],
  divergence_requests: ["company_name", "notes", "created_by_name", "updated_by_name"],
  divergence_items: ["product_name", "store_notes", "stock_response", "responded_by_name", "store_reply", "store_reply_by_name", "inventoried_by_name", "created_by_name", "updated_by_name"],
  divergence_item_events: ["text", "actor_name"],
  assist_defects: ["category", "device", "name", "created_by_name", "updated_by_name"],
  assist_quotes: ["company_name", "client_name", "client_address", "observations", "extra_notes", "created_by_name", "updated_by_name"],
  assist_quote_items: ["category", "device", "model", "service", "defect_name", "description"],
  assist_payment_options: ["label", "created_by_name", "updated_by_name"],
  assist_categories: ["name", "created_by_name", "updated_by_name"],
  assist_service_orders: ["category", "equipment", "store_name", "situation", "last_update_text", "last_update_by_name", "ship_by_name", "store_check_by_name", "store_check_note", "created_by_name", "updated_by_name"],
  assist_service_order_updates: ["update_text", "created_by_name"],
  assist_repair_prices: ["service", "brand", "model", "created_by_name", "updated_by_name"],
  assist_stock_items: ["category", "name", "created_by_name", "updated_by_name"],
  assist_stock_movements: ["note", "created_by_name"],
  ops_audit_items: ["section", "group_name", "text", "updated_by_name"],
  ops_audits: ["company_name", "auditor_name", "finalized_by_name"],
  ops_audit_answers: ["section", "group_name", "text", "note", "updated_by_name"],
  commercial_gd_store_info: ["updated_by_name"],
};

const PLACEHOLDER = /^\?(\d*)$/;

// Divide "a, f(b, c), 'x,y'" nas vírgulas de nível 0 (fora de parênteses e
// aspas), devolvendo cada parte com a posição em que começa.
function splitTopLevel(text: string, offset: number): Array<{ part: string; at: number }> {
  const parts: Array<{ part: string; at: number }> = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (index === text.length || (char === "," && depth === 0)) {
      const raw = text.slice(start, index);
      parts.push({ part: raw.trim(), at: offset + start + (raw.length - raw.trimStart().length) });
      start = index + 1;
    }
  }
  return parts;
}

// Fecha o parêntese aberto em `open`; -1 se não fechar.
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

// Índice (0-based) do parâmetro de um placeholder: "?3" → 2; "?" → quantos
// "?" sem número vêm antes dele na query.
function paramIndex(query: string, expr: string, at: number): number | null {
  const match = PLACEHOLDER.exec(expr);
  if (!match) return null;
  if (match[1]) return Number(match[1]) - 1;
  return (query.slice(0, at).match(/\?(?!\d)/g) ?? []).length;
}

// "col = ?2, outra = COALESCE(?3, outra)" → só atribuições diretas contam.
function collectAssignments(query: string, from: number, columns: readonly string[], out: Set<number>) {
  const rest = query.slice(from);
  const stop = rest.search(/\b(WHERE|RETURNING|FROM|ON\s+CONFLICT)\b/i);
  const setList = stop === -1 ? rest : rest.slice(0, stop);
  for (const { part, at } of splitTopLevel(setList, from)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const column = part.slice(0, eq).trim().replace(/"/g, "").toLowerCase();
    if (!columns.includes(column)) continue;
    const expr = part.slice(eq + 1);
    const index = paramIndex(query, expr.trim(), at + eq + 1 + (expr.length - expr.trimStart().length));
    if (index !== null) out.add(index);
  }
}

// Quais parâmetros (índices de bind) desta query caem em coluna de texto
// livre. null = query que não grava texto livre (a grande maioria).
export function upperParamIndexes(query: string): Set<number> | null {
  const insert = /^\s*INSERT\s+INTO\s+"?(\w+)"?\s*\(/i.exec(query);
  const update = insert ? null : /^\s*UPDATE\s+"?(\w+)"?\s+SET\s/i.exec(query);
  const table = (insert ?? update)?.[1]?.toLowerCase();
  const columns = table ? UPPER_TEXT_COLUMNS[table] : undefined;
  if (!columns) return null;
  const out = new Set<number>();

  if (update) {
    collectAssignments(query, update[0].length, columns, out);
  } else if (insert) {
    const colsOpen = insert[0].length - 1;
    const colsClose = closeParen(query, colsOpen);
    if (colsClose === -1) return null;
    const names = splitTopLevel(query.slice(colsOpen + 1, colsClose), colsOpen + 1).map(({ part }) =>
      part.replace(/"/g, "").toLowerCase(),
    );
    const values = /^\s*VALUES\s*/i.exec(query.slice(colsClose + 1));
    if (values) {
      // Uma ou mais tuplas: VALUES (?, ?), (?, ?)
      let cursor = colsClose + 1 + values[0].length;
      while (query[cursor] === "(") {
        const close = closeParen(query, cursor);
        if (close === -1) break;
        splitTopLevel(query.slice(cursor + 1, close), cursor + 1).forEach(({ part, at }, position) => {
          if (!columns.includes(names[position] ?? "")) return;
          const index = paramIndex(query, part, at);
          if (index !== null) out.add(index);
        });
        cursor = close + 1;
        while (/[\s,]/.test(query[cursor] ?? "")) cursor++;
      }
    }
    const upsert = /\bDO\s+UPDATE\s+SET\s/i.exec(query);
    if (upsert) collectAssignments(query, upsert.index + upsert[0].length, columns, out);
  }
  return out.size ? out : null;
}

type Bindable = { bind(...values: unknown[]): unknown };
type Preparer = { prepare(query: string): Bindable };

export function withUpperText<T extends Preparer>(database: T): T {
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (query: string) => {
        const statement = target.prepare(query);
        const indexes = upperParamIndexes(query);
        if (!indexes) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) =>
          bind(...values.map((value, index) => (indexes.has(index) ? upperText(value) : value)));
        return statement;
      };
    },
  });
}

// Cadastros guardados como JSON no shared_state (lojas, tarefas): só estes
// campos de texto livre viram maiúsculas; ids, CNPJ, telefone, e-mail,
// cores, status etc. ficam como estão.
export const UPPER_JSON_STATE_KEY = /^(companies_list|tarefas:.+)$/;
const UPPER_JSON_FIELDS = new Set(["name", "legalName", "address", "text"]);

export function upperJsonFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(upperJsonFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      UPPER_JSON_FIELDS.has(key) && typeof item === "string" ? upperText(item) : upperJsonFields(item),
    ]),
  );
}
