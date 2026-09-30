import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  MONTH_PATTERN,
  aliasKey,
  isSellerRole,
  matchEmployee,
  parseSellerSheet,
  type EmployeeCandidate,
  type SheetRow,
} from "../../../lib/commercial";
import {
  actorName,
  canManageCommercial,
  commercialScope,
  identity,
  jsonResponse,
  loadCompanyNames,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Importação da planilha "ACOMPANHAMENTO LOJAS_VENDEDORES" (aba
// "VENDEDORES <MÊS>") — única forma de alimentar o Comercial (decisão
// confirmada com o usuário). O navegador só lê o arquivo (SheetJS) e manda
// as células cruas; a interpretação é toda aqui (parseSellerSheet), em
// dois passos:
//   1. confirm=false → prévia: vendedores reconhecidos, não reconhecidos
//      (o usuário escolhe o funcionário ou ignora) e erros;
//   2. confirm=true  → grava o retrato do mês (substitui o que havia no
//      mês, dentro do alcance de loja de quem importa), salva os vínculos
//      apelido → funcionário e registra a importação no histórico.

const MAX_ROWS = 3000;
const MAX_COLUMNS = 80;

type EmployeeRow = {
  id: string;
  fullName: string;
  roleTitle: string;
  companyId: string;
  companyName: string;
};

type PreviewRow = SheetRow & {
  aliasKey: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  matchedBy: "alias" | "name" | "manual" | "";
  status: "ok" | "unmatched" | "ignored" | "out_of_scope" | "duplicate";
};

function sanitizeCells(value: unknown): unknown[][] | null {
  if (!Array.isArray(value) || value.length > MAX_ROWS) return null;
  const rows: unknown[][] = [];
  for (const row of value) {
    if (!Array.isArray(row)) return null;
    rows.push(
      row.slice(0, MAX_COLUMNS).map((cell) =>
        typeof cell === "number" ? cell : typeof cell === "string" ? cell.slice(0, 200) : cell == null ? "" : String(cell).slice(0, 200),
      ),
    );
  }
  return rows;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA IMPORTAR A PLANILHA." }, 403);
  }
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, file_name AS fileName, sheet_name AS sheetName, rows_imported AS rowsImported,
                rows_ignored AS rowsIgnored, created_by_name AS createdByName, created_at AS createdAt
         FROM commercial_imports WHERE month=?1 ORDER BY created_at DESC LIMIT 50`,
      )
      .bind(month)
      .all();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o histórico de importações.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O HISTÓRICO DE IMPORTAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA IMPORTAR A PLANILHA." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    const fileName = safeText(body.fileName, 200);
    const sheetName = safeText(body.sheetName, 120);
    const confirm = body.confirm === true;
    const cells = sanitizeCells(body.cells);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "MÊS INVÁLIDO." }, 400);
    if (!cells) return jsonResponse({ error: "PLANILHA INVÁLIDA OU GRANDE DEMAIS." }, 400);
    const mappings = (body.mappings && typeof body.mappings === "object" ? body.mappings : {}) as Record<string, unknown>;

    const parsed = parseSellerSheet(cells);
    const database = await getD1();
    const [employeesResult, aliasesResult, companyNames] = await Promise.all([
      database
        .prepare(
          `SELECT id, full_name AS fullName, role_title AS roleTitle, company_id AS companyId,
                  company_name AS companyName
           FROM hr_employees WHERE status='active' ORDER BY full_name ASC`,
        )
        .all<EmployeeRow>(),
      database
        .prepare("SELECT alias_key AS aliasKey, employee_id AS employeeId FROM commercial_aliases")
        .all<{ aliasKey: string; employeeId: string }>(),
      loadCompanyNames(database),
    ]);
    const employees = (employeesResult.results ?? []).map((employee) => ({
      ...employee,
      companyName: companyNames.get(employee.companyId) || employee.companyName,
    }));
    const byId = new Map(employees.map((employee) => [employee.id, employee]));
    const candidates: EmployeeCandidate[] = employees.map((employee) => ({
      id: employee.id,
      fullName: employee.fullName,
      companyName: employee.companyName,
      isSeller: isSellerRole(employee.roleTitle),
    }));
    const aliases = new Map((aliasesResult.results ?? []).map((row) => [row.aliasKey, row.employeeId]));
    const inScope = (companyId: string) => scope.allStores || companyId === scope.companyId;

    const used = new Map<string, number>();
    const rows: PreviewRow[] = parsed.rows.map((row) => {
      const key = aliasKey(row.storeLabel, row.sellerLabel);
      const manual = mappings[key];
      let employeeId = "";
      let matchedBy: PreviewRow["matchedBy"] = "";
      if (typeof manual === "string") {
        employeeId = byId.has(manual) ? manual : "";
        matchedBy = employeeId ? "manual" : "";
      } else {
        const match = matchEmployee(row, candidates, aliases);
        if (match) {
          employeeId = match.employeeId;
          matchedBy = match.by;
        }
      }
      const employee = employeeId ? byId.get(employeeId) : undefined;
      let status: PreviewRow["status"] = "ok";
      if (manual === "") status = "ignored";
      else if (!employee) status = "unmatched";
      else if (!inScope(employee.companyId)) status = "out_of_scope";
      if (status === "ok") used.set(employeeId, (used.get(employeeId) ?? 0) + 1);
      return {
        ...row,
        aliasKey: key,
        employeeId,
        employeeName: employee?.fullName ?? "",
        companyId: employee?.companyId ?? "",
        companyName: employee?.companyName ?? "",
        matchedBy,
        status,
      };
    });
    for (const row of rows) {
      if (row.status === "ok" && (used.get(row.employeeId) ?? 0) > 1) row.status = "duplicate";
    }

    const toImport = rows.filter((row) => row.status === "ok");
    const summary = {
      total: rows.length,
      ok: toImport.length,
      unmatched: rows.filter((row) => row.status === "unmatched").length,
      ignored: rows.filter((row) => row.status === "ignored").length,
      outOfScope: rows.filter((row) => row.status === "out_of_scope").length,
      duplicate: rows.filter((row) => row.status === "duplicate").length,
    };

    if (!confirm) {
      return jsonResponse({
        month,
        allStores: scope.allStores,
        rows,
        errors: parsed.errors,
        summary,
        // Opções pro "escolher funcionário" das linhas não reconhecidas —
        // só quem está no alcance de loja de quem importa.
        employees: employees
          .filter((employee) => inScope(employee.companyId))
          .map((employee) => ({ id: employee.id, fullName: employee.fullName, companyName: employee.companyName })),
      });
    }

    if (summary.unmatched || summary.duplicate) {
      return jsonResponse(
        { error: "RESOLVA AS LINHAS NÃO RECONHECIDAS OU DUPLICADAS (ESCOLHA O FUNCIONÁRIO OU IGNORE) ANTES DE CONFIRMAR." },
        400,
      );
    }
    if (!toImport.length) return jsonResponse({ error: "NENHUM VENDEDOR PARA IMPORTAR." }, 400);

    const importId = crypto.randomUUID();
    const who = actorName(actor);
    const statements = [
      // O retrato do mês é substituído por completo dentro do alcance de
      // loja de quem importa (quem saiu da planilha sai do dashboard).
      scope.allStores
        ? database.prepare("DELETE FROM commercial_monthly WHERE month=?1").bind(month)
        : database.prepare("DELETE FROM commercial_monthly WHERE month=?1 AND company_id=?2").bind(month, scope.companyId),
      ...toImport.map((row) =>
        database
          .prepare(
            `INSERT INTO commercial_monthly
              (id, employee_id, employee_name, company_id, company_name, sheet_seller_name, sheet_store_name,
               zone, month, target_revenue_cents, target_items, target_super_items, target_warranty_cents,
               target_realme, revenue_cents, items, warranty_cents, realme, warranty_qty, notebook_qty,
               import_id, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                     ?21, ?22, ?23, CURRENT_TIMESTAMP)
             ON CONFLICT (employee_id, month) DO UPDATE SET
               employee_name=excluded.employee_name, company_id=excluded.company_id,
               company_name=excluded.company_name, sheet_seller_name=excluded.sheet_seller_name,
               sheet_store_name=excluded.sheet_store_name, zone=excluded.zone,
               target_revenue_cents=excluded.target_revenue_cents, target_items=excluded.target_items,
               target_super_items=excluded.target_super_items,
               target_warranty_cents=excluded.target_warranty_cents, target_realme=excluded.target_realme,
               revenue_cents=excluded.revenue_cents, items=excluded.items,
               warranty_cents=excluded.warranty_cents, realme=excluded.realme,
               warranty_qty=excluded.warranty_qty, notebook_qty=excluded.notebook_qty,
               import_id=excluded.import_id, updated_by=excluded.updated_by,
               updated_by_name=excluded.updated_by_name, updated_at=CURRENT_TIMESTAMP`,
          )
          .bind(
            crypto.randomUUID(), row.employeeId, row.employeeName, row.companyId, row.companyName,
            row.sellerLabel, row.storeLabel, row.zone, month,
            row.targetRevenueCents, row.targetItems, row.targetSuperItems, row.targetWarrantyCents, row.targetRealme,
            row.revenueCents, row.items, row.warrantyCents, row.realme, row.warrantyQty, row.notebookQty,
            importId, actor.id, who,
          ),
      ),
      ...toImport
        .filter((row) => row.matchedBy === "manual" || row.matchedBy === "name")
        .map((row) =>
          database
            .prepare(
              `INSERT INTO commercial_aliases (alias_key, employee_id, updated_by, updated_at)
               VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
               ON CONFLICT (alias_key) DO UPDATE SET employee_id=excluded.employee_id,
                 updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`,
            )
            .bind(row.aliasKey, row.employeeId, actor.id),
        ),
      database
        .prepare(
          `INSERT INTO commercial_imports
            (id, month, file_name, sheet_name, rows_imported, rows_ignored, company_id,
             created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)`,
        )
        .bind(
          importId, month, fileName, sheetName, toImport.length, rows.length - toImport.length,
          scope.allStores ? "" : scope.companyId, actor.id, who,
        ),
    ];
    await database.batch(statements);
    return jsonResponse({ imported: toImport.length, summary }, 201);
  } catch (error) {
    console.error("Não foi possível importar a planilha do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL IMPORTAR A PLANILHA." }, 500);
  }
}
