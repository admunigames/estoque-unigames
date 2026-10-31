import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { actingStoresForMonth } from "../../../../../lib/acting-store";
import { loadCompanyList } from "../../../../finance/shared";
import {
  canEmployees,
  canSeeEmployees,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  saveActingStoreMonth,
  type JsonMap,
} from "../../../shared";

// RH > Funcionários > LOJA ATUANTE (31/10/2026): a loja em que cada ativo
// atua no mês, em LOTE. GET ?month → loja atuante de todos no mês; POST
// {month, items:[{employeeId, companyId}]} grava só os que mudaram, um a um,
// pela mesma regra da loja atuante do cadastro (saveActingStoreMonth).

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canSeeEmployees(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER OS FUNCIONÁRIOS." }, 403);
  const month = safeText(new URL(request.url).searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
  try {
    const stores = await actingStoresForMonth(await getD1(), month);
    return jsonResponse({ month, stores: Object.fromEntries(stores) });
  } catch (error) {
    console.error("Não foi possível carregar as lojas atuantes.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS LOJAS ATUANTES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canEmployees(actor, "edit")) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR FUNCIONÁRIOS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
    const raw = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    const database = await getD1();
    const companies = await loadCompanyList(database);
    const nameOf = (id: string) => (id === "assistencia" ? "Assistência" : companies.find((item) => item.id === id)?.name);
    const employees = new Map(
      ((await database.prepare("SELECT id, full_name AS fullName FROM hr_employees").all<{ id: string; fullName: string }>()).results ?? [])
        .map((row) => [row.id, row.fullName]),
    );
    // Valida tudo antes de gravar: nada fica pela metade por um item ruim.
    const items = [];
    for (const entry of raw) {
      const item = (entry ?? {}) as JsonMap;
      const employeeId = safeText(item.employeeId, 80);
      const companyId = safeText(item.companyId, 80);
      const companyName = nameOf(companyId);
      if (!employees.has(employeeId)) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
      if (!companyName) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
      items.push({ employeeId, employeeName: employees.get(employeeId) ?? "", store: { companyId, companyName } });
    }
    // ponytail: um mês por vez em sequência (≈70 funcionários); juntar num
    // batch só se ficar lento.
    for (const item of items) await saveActingStoreMonth(database, actor, { ...item, month });
    return jsonResponse({ saved: items.length });
  } catch (error) {
    console.error("Não foi possível gravar as lojas atuantes.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR AS LOJAS ATUANTES." }, 500);
  }
}
