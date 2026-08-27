import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../../lib/access-scope";
import {
  applyMachineEvent,
  isMachineEventKind,
  type MachineEventKind,
} from "../../../../../lib/card-machines";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../../shared";

// Histórico da maquineta: transferência, manutenção, substituição e
// cancelamento. A transferência e o cancelamento também mudam o estado da
// maquineta (loja / status), na MESMA escrita do evento — a regra de "o que
// cada evento faz" mora em app/lib/card-machines.ts (testável sem banco).

type MachineScopeRow = { companyId: string; companyName: string; status: string };

function scopeActorOf(request: Request, actor: ReturnType<typeof identity>) {
  return {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
}

async function loadMachine(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT company_id AS companyId, company_name AS companyName, status
       FROM finance_card_machines WHERE id=?1`,
    )
    .bind(id)
    .first<MachineScopeRow>();
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const { id } = await context.params;
  const machineId = safeText(id, 80);

  try {
    const database = await getD1();
    const machine = await loadMachine(database, machineId);
    if (!machine) return jsonResponse({ error: "MAQUINETA NÃO ENCONTRADA." }, 404);

    const scopeActor = scopeActorOf(request, actor);
    const allStores = canSeeAllStores(scopeActor, "finance:manage");
    if (!allStores && machine.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESTA MAQUINETA." }, 403);
    }

    const result = await database
      .prepare(
        `SELECT id, kind, event_date AS eventDate,
                from_company_id AS fromCompanyId, from_company_name AS fromCompanyName,
                to_company_id AS toCompanyId, to_company_name AS toCompanyName,
                description, created_by_name AS createdByName, created_at AS createdAt
         FROM finance_card_machine_events
         WHERE machine_id=?1
         ORDER BY event_date DESC, created_at DESC`,
      )
      .bind(machineId)
      .all();
    return jsonResponse({ events: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o histórico da maquineta.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O HISTÓRICO DA MAQUINETA." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR EVENTOS DE MAQUINETA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;
  const machineId = safeText(id, 80);

  try {
    const body = (await request.json()) as JsonMap;
    const kind = body.kind as MachineEventKind;
    if (!isMachineEventKind(kind)) {
      return jsonResponse({ error: "TIPO DE EVENTO INVÁLIDO." }, 400);
    }
    const eventDate = safeText(body.eventDate, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return jsonResponse({ error: "INFORME A DATA DO EVENTO." }, 400);
    }
    const description = safeText(body.description, 1000);
    const toCompanyId = safeText(body.toCompanyId, 80);

    const database = await getD1();
    const machine = await loadMachine(database, machineId);
    if (!machine) return jsonResponse({ error: "MAQUINETA NÃO ENCONTRADA." }, 404);

    const scopeActor = scopeActorOf(request, actor);
    const allStores = canSeeAllStores(scopeActor, "finance:manage");
    if (!allStores && !hasCompany(scopeActor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    if (!allStores && machine.companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESTA MAQUINETA." }, 403);
    }
    if (machine.status === "canceled") {
      return jsonResponse({ error: "ESTA MAQUINETA ESTÁ CANCELADA." }, 409);
    }

    const companies = await loadCompanyList(database);
    const toCompanyName = toCompanyId
      ? (companies.find((row) => row.id === toCompanyId)?.name ?? "")
      : "";
    if (kind === "transfer" && toCompanyId && !toCompanyName) {
      return jsonResponse({ error: "UNIDADE DE DESTINO NÃO ENCONTRADA." }, 400);
    }

    const applied = applyMachineEvent(
      { companyId: machine.companyId, companyName: machine.companyName, status: machine.status as never },
      { kind, toCompanyId, toCompanyName },
    );
    if (applied.error) return jsonResponse({ error: applied.error }, 400);

    const who = actor.displayName || "Administrador";
    const eventId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_card_machine_events
          (id, machine_id, kind, event_date, from_company_id, from_company_name,
           to_company_id, to_company_name, description, created_by, created_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        eventId,
        machineId,
        kind,
        eventDate,
        machine.companyId,
        machine.companyName,
        kind === "transfer" ? toCompanyId : "",
        kind === "transfer" ? toCompanyName : "",
        description,
        actor.id,
        who,
      )
      .run();

    const next = applied.state;
    if (next.companyId !== machine.companyId || next.status !== machine.status) {
      await database
        .prepare(
          `UPDATE finance_card_machines
           SET company_id=?1, company_name=?2, status=?3,
               updated_by=?4, updated_by_name=?5, updated_at=now()::text
           WHERE id=?6`,
        )
        .bind(next.companyId, next.companyName, next.status, actor.id, who, machineId)
        .run();
    }

    return jsonResponse({ created: true, id: eventId, machineStatus: next.status }, 201);
  } catch (error) {
    console.error("Não foi possível registrar o evento da maquineta.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O EVENTO DA MAQUINETA." }, 500);
  }
}
