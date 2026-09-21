import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  MOVEMENT_COLUMNS,
  actorName,
  canManageUniformStock,
  canViewUniformStock,
  identity,
  isMovementType,
  isPieceType,
  isSize,
  jsonResponse,
  resolveMovementDelta,
  safeText,
  sameOrigin,
  stockItemId,
  uuidIsValid,
  type Identity,
  type JsonMap,
  type MovementRow,
} from "../shared";

// Lançamentos de saída/entrada(devolução)/ajuste. "quantity" gravado é
// sempre o DELTA já assinado que foi aplicado ao saldo — saída fixa -1,
// entrada fixa +1, ajuste é o delta livre que o usuário informou (o
// front-end calcula esse delta a partir da diferença entre o saldo exibido
// e o novo valor desejado, mas quem persiste é sempre o delta, nunca um
// valor absoluto). Isso garante `stock_qty = stock_qty + delta` num único
// UPDATE relativo, sem condição de corrida em lançamentos simultâneos —
// mesma técnica de app/api/supplies/stock/route.ts.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewUniformStock(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FARDAMENTO." }, 403);
  }

  try {
    const url = new URL(request.url);
    const pieceType = safeText(url.searchParams.get("pieceType"), 20);
    const employeeId = safeText(url.searchParams.get("employeeId"), 80);
    const movementType = safeText(url.searchParams.get("movementType"), 20);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (pieceType && isPieceType(pieceType)) {
      bindings.push(pieceType);
      conditions.push(`piece_type=?${bindings.length}`);
    }
    if (employeeId) {
      bindings.push(employeeId);
      conditions.push(`employee_id=?${bindings.length}`);
    }
    if (movementType && isMovementType(movementType)) {
      bindings.push(movementType);
      conditions.push(`movement_type=?${bindings.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const database = await getD1();
    const query = `SELECT ${MOVEMENT_COLUMNS} FROM uniform_stock_movements ${where} ORDER BY created_at DESC LIMIT 500`;
    const result = bindings.length
      ? await database.prepare(query).bind(...bindings).all<MovementRow>()
      : await database.prepare(query).all<MovementRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os lançamentos de fardamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS LANÇAMENTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor: Identity = identity(request);
  if (!canManageUniformStock(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR MOVIMENTAÇÕES DE FARDAMENTO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const movementType = safeText(body.movementType, 20);
    const pieceType = safeText(body.pieceType, 20);
    const size = safeText(body.size, 10);
    const employeeId = safeText(body.employeeId, 80);
    const employeeName = safeText(body.employeeName, 160);
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 120);
    const movementDate = safeText(body.movementDate, 10);
    const note = safeText(body.note, 500);
    const adjustmentDelta = Math.trunc(Number(body.quantity ?? 0));

    if (!isMovementType(movementType)) return jsonResponse({ error: "TIPO DE LANÇAMENTO INVÁLIDO." }, 400);
    if (!isPieceType(pieceType)) return jsonResponse({ error: "TIPO DE PEÇA INVÁLIDO." }, 400);
    if (!isSize(size)) return jsonResponse({ error: "TAMANHO INVÁLIDO." }, 400);
    if (!movementDate || !DATE_PATTERN.test(movementDate)) {
      return jsonResponse({ error: "INFORME UMA DATA VÁLIDA (AAAA-MM-DD)." }, 400);
    }
    if ((movementType === "saida" || movementType === "entrada") && !employeeId) {
      return jsonResponse({ error: "SELECIONE O COLABORADOR." }, 400);
    }
    if (movementType === "ajuste" && (!Number.isFinite(adjustmentDelta) || adjustmentDelta === 0)) {
      return jsonResponse({ error: "INFORME UM AJUSTE DE QUANTIDADE VÁLIDO (DIFERENTE DE ZERO)." }, 400);
    }
    if (pieceType === "casacos" && (movementType === "saida" || movementType === "entrada") && !companyId) {
      return jsonResponse({ error: "SELECIONE A LOJA DO CASACO." }, 400);
    }

    const database = await getD1();

    if (employeeId) {
      const employee = await database
        .prepare("SELECT id, full_name AS fullName FROM hr_employees WHERE id=?1 LIMIT 1")
        .bind(employeeId)
        .first<{ id: string; fullName: string }>();
      if (!employee) return jsonResponse({ error: "COLABORADOR NÃO ENCONTRADO." }, 404);
    }

    const delta = resolveMovementDelta(movementType, adjustmentDelta);
    const id = crypto.randomUUID();
    const itemId = stockItemId(pieceType, size);

    const statements = [
      database
        .prepare(
          `INSERT INTO uniform_stock_movements
            (id, movement_type, piece_type, size, quantity, employee_id, employee_name,
             company_id, company_name, movement_date, note, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP)`,
        )
        .bind(
          id,
          movementType,
          pieceType,
          size,
          delta,
          employeeId,
          employeeName,
          companyId,
          companyName,
          movementDate,
          note,
          actor.id,
          actorName(actor),
        ),
      database
        .prepare(`UPDATE uniform_stock_items SET stock_qty = stock_qty + ?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2`)
        .bind(delta, itemId),
    ];

    // Termo de Responsabilidade — 1 por saída de casaco, criado
    // automaticamente na mesma transação (decisão confirmada com o
    // usuário), status inicial "aguardando_assinatura".
    let termId = "";
    if (pieceType === "casacos" && movementType === "saida") {
      termId = crypto.randomUUID();
      statements.push(
        database
          .prepare(
            `INSERT INTO uniform_coat_terms
              (id, movement_id, employee_id, employee_name, company_id, company_name, size,
               status, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'aguardando_assinatura', ?8, ?9, CURRENT_TIMESTAMP, ?8, ?9, CURRENT_TIMESTAMP)`,
          )
          .bind(termId, id, employeeId, employeeName, companyId, companyName, size, actor.id, actorName(actor)),
      );
    }

    await database.batch(statements);
    return jsonResponse({ created: true, id, termId: termId || undefined }, 201);
  } catch (error) {
    console.error("Não foi possível registrar o lançamento de fardamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O LANÇAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageUniformStock(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR LANÇAMENTOS DE FARDAMENTO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const movement = await database
      .prepare("SELECT id, piece_type AS pieceType, size, quantity FROM uniform_stock_movements WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string; pieceType: string; size: string; quantity: number }>();
    if (!movement) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);

    const term = await database
      .prepare("SELECT id, r2_key AS r2Key FROM uniform_coat_terms WHERE movement_id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string; r2Key: string }>();

    const reverseDelta = -movement.quantity;
    const itemId = stockItemId(movement.pieceType, movement.size);
    const statements = [
      database.prepare("DELETE FROM uniform_stock_movements WHERE id=?1").bind(id),
      database
        .prepare(`UPDATE uniform_stock_items SET stock_qty = stock_qty + ?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2`)
        .bind(reverseDelta, itemId),
    ];
    if (term) {
      statements.push(database.prepare("DELETE FROM uniform_coat_terms WHERE id=?1").bind(term.id));
    }
    await database.batch(statements);

    if (term?.r2Key) {
      const { documentsBucket } = await import("../../documents/shared");
      const bucket = await documentsBucket();
      await bucket.delete(term.r2Key).catch(() => undefined);
    }

    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento de fardamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO." }, 500);
  }
}
