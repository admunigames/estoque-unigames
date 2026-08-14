import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../lib/access-scope";
import {
  CAPTURE_SELECT,
  CAPTURE_STATUSES,
  COMPANY_PATTERN,
  GAME_CONDITIONS,
  GAME_CONSOLES,
  MAX_CAPTURE_CONTROLLERS,
  can,
  canAccessCaptures,
  companyName,
  identity,
  isAssistanceActor,
  isValidPhotoKey,
  jsonResponse,
  safeText,
  sameOrigin,
  serializeCaptureRow,
  uploadsBucket,
  type CaptureCategory,
  type CaptureRow,
  type CaptureStatus,
  type GameCondition,
  type GameConsole,
  type JsonMap,
} from "./shared";

type ControllerInput = {
  productName: string;
  serialNumber: string;
  color: string;
  defects: string;
  capturedValueCents: number;
};

function parseControllers(rawControllers: unknown): ControllerInput[] | string {
  if (!Array.isArray(rawControllers) || rawControllers.length === 0) return [];
  if (rawControllers.length > MAX_CAPTURE_CONTROLLERS) {
    return `INFORME NO MÁXIMO ${MAX_CAPTURE_CONTROLLERS} CONTROLES POR CAPTAÇÃO.`;
  }
  const controllers: ControllerInput[] = [];
  for (let index = 0; index < rawControllers.length; index += 1) {
    const raw = rawControllers[index];
    const item = raw && typeof raw === "object" ? (raw as JsonMap) : {};
    const label = `CONTROLE ${index + 1}`;
    const productName = safeText(item.productName, 160);
    const serialNumber = safeText(item.serialNumber, 160);
    const color = safeText(item.color, 120);
    const defects = safeText(item.defects, 1200);
    if (productName.length < 2) return `${label}: INFORME O MODELO/TIPO DO CONTROLE.`;
    if (!serialNumber) return `${label}: INFORME O SERIAL DO CONTROLE.`;
    if (!color) return `${label}: INFORME A COR DO CONTROLE.`;
    const rawValue = Number(item.capturedValue);
    const value = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 0;
    if (value > 999999.99) return `${label}: VALOR CAPTADO INVÁLIDO.`;
    controllers.push({
      productName,
      serialNumber,
      color,
      defects,
      capturedValueCents: Math.round(value * 100),
    });
  }
  return controllers;
}

async function insertCaptureRow(
  database: D1Database,
  params: {
    id: string;
    category: CaptureCategory;
    productName: string;
    gameName: string;
    gameConsole: string;
    gameCondition: string;
    serialNumber: string;
    defects: string;
    color: string;
    originCompanyId: string;
    originCompanyName: string;
    capturedValueCents: number;
    photoKey: string;
    parentCaptureId: string;
    createdBy: string;
    createdByName: string;
  },
) {
  await database
    .prepare(
      `INSERT INTO captured_products
        (id, category, product_name, game_name, game_console, game_condition,
         serial_number, defects, color,
         origin_company_id, origin_company_name, captured_value_cents,
         photo_key, parent_capture_id, status, created_by, created_by_name,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
               CASE WHEN ?2 = 'jogo' THEN 'ready' ELSE 'submitted' END,
               ?15, ?16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(
      params.id,
      params.category,
      params.productName,
      params.gameName,
      params.gameConsole,
      params.gameCondition,
      params.serialNumber,
      params.defects,
      params.color,
      params.originCompanyId,
      params.originCompanyName,
      params.capturedValueCents,
      params.photoKey,
      params.parentCaptureId,
      params.createdBy,
      params.createdByName,
    )
    .run();
}

function liveCaptureResponse(
  body: JsonMap,
  status: number,
  capture: Pick<CaptureRow, "originCompanyId" | "category">,
): Response {
  const response = jsonResponse(body, status);
  // Metadados internos consumidos e removidos pelo Worker antes da resposta ao
  // navegador. Assim o aviso chega apenas a admin, origem e Assistencia quando
  // a propria API permite, sem transportar o registro pelo WebSocket.
  response.headers.set("x-unigames-live-company-id", capture.originCompanyId);
  response.headers.set("x-unigames-live-capture-category", capture.category);
  return response;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
  }

  try {
    const database = await getD1();
    const allStores = canSeeAllStores(actor, "captures:view") || isAssistanceActor(actor);
    if (!allStores && !hasCompany(actor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    const result = isAssistanceActor(actor) && actor.role !== "admin"
      ? await database
          .prepare(
            `${CAPTURE_SELECT}
             WHERE category <> 'jogo'
             ORDER BY CASE status
               WHEN 'ready' THEN 0 WHEN 'submitted' THEN 1
               WHEN 'received' THEN 2 ELSE 3 END,
               updated_at DESC`,
          )
          .all<CaptureRow>()
      : allStores
        ? await database
            .prepare(
              `${CAPTURE_SELECT}
               ORDER BY CASE status
                 WHEN 'ready' THEN 0 WHEN 'submitted' THEN 1
                 WHEN 'received' THEN 2 ELSE 3 END,
                 updated_at DESC`,
            )
            .all<CaptureRow>()
      : await database
          .prepare(
            `${CAPTURE_SELECT}
             WHERE origin_company_id=?1
             ORDER BY updated_at DESC`,
          )
          .bind(actor.companyId)
          .all<CaptureRow>();

    const requestedStatus = safeText(
      new URL(request.url).searchParams.get("status"),
      30,
    ) as CaptureStatus;
    const rows = result.results ?? [];
    const filteredRows = CAPTURE_STATUSES.has(requestedStatus)
      ? rows.filter((row) => row.status === requestedStatus)
      : rows;
    return jsonResponse({
      captures: filteredRows.map((row) => serializeCaptureRow(actor, row)),
    });
  } catch (error) {
    console.error("Não foi possível carregar as captações.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CAPTAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "captures:create")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CAPTAÇÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  if (isAssistanceActor(actor)) {
    return jsonResponse(
      { error: "A ASSISTÊNCIA NÃO PODE CADASTRAR PRODUTOS CAPTADOS." },
      403,
    );
  }

  try {
    const body = (await request.json()) as JsonMap;

    const requestedOriginCompanyId = safeText(body.originCompanyId, 80);
    const canChooseCompany = canSeeAllStores(actor, "captures:create");
    const originCompanyId = canChooseCompany ? requestedOriginCompanyId : actor.companyId;
    if (!COMPANY_PATTERN.test(originCompanyId)) {
      return jsonResponse(
        { error: canChooseCompany ? "ESCOLHA A LOJA DE ORIGEM." : NO_COMPANY_ERROR },
        400,
      );
    }
    const category: CaptureCategory =
      body.category === "console" ||
      body.category === "controller" ||
      body.category === "jogo"
        ? body.category
        : "other";
    const gameName = safeText(body.gameName, 160);
    const gameConsole = safeText(body.gameConsole, 40) as GameConsole;
    const gameCondition = safeText(body.gameCondition, 40) as GameCondition;
    // Jogos usam só os campos específicos de jogo (nome/console/estado/valor)
    // — produto/modelo, serial, cor e defeitos não fazem sentido pra esse
    // fluxo e nem aparecem mais no formulário, então não são exigidos aqui.
    const productName = category === "jogo" ? "" : safeText(body.productName, 160);
    const serialNumber = category === "jogo" ? "" : safeText(body.serialNumber, 160);
    const defects = category === "jogo" ? "" : safeText(body.defects, 1200);
    const color = category === "jogo" ? "" : safeText(body.color, 120);
    if (category !== "jogo") {
      if (productName.length < 2) {
        return jsonResponse({ error: "INFORME O PRODUTO OU MODELO." }, 400);
      }
      if (!serialNumber) {
        return jsonResponse({ error: "INFORME O SERIAL DO PRODUTO." }, 400);
      }
      if (!defects) {
        return jsonResponse({ error: "INFORME OS DEFEITOS OU ESCREVA “SEM DEFEITO”." }, 400);
      }
      if (!color) return jsonResponse({ error: "INFORME A COR DO PRODUTO." }, 400);
    }
    const rawCapturedValue = Number(body.capturedValue);
    const capturedValue =
      Number.isFinite(rawCapturedValue) && rawCapturedValue > 0
        ? rawCapturedValue
        : 0;
    if (capturedValue > 999999.99) {
      return jsonResponse({ error: "VALOR CAPTADO INVÁLIDO." }, 400);
    }
    const capturedValueCents = Math.round(capturedValue * 100);
    if (category === "jogo") {
      if (gameName.length < 2) {
        return jsonResponse({ error: "INFORME O NOME DO JOGO." }, 400);
      }
      if (!GAME_CONSOLES.has(gameConsole)) {
        return jsonResponse({ error: "ESCOLHA O CONSOLE DO JOGO." }, 400);
      }
      if (!GAME_CONDITIONS.has(gameCondition)) {
        return jsonResponse({ error: "ESCOLHA O ESTADO DO JOGO." }, 400);
      }
      if (capturedValue <= 0) {
        return jsonResponse({ error: "INFORME O VALOR CAPTADO DO JOGO." }, 400);
      }
    }
    const requestedPhotoKey = safeText(body.photoKey, 200);
    let photoKey = "";
    if (requestedPhotoKey) {
      if (!isValidPhotoKey(requestedPhotoKey)) {
        return jsonResponse({ error: "FOTO INVÁLIDA. TENTE ENVIAR NOVAMENTE." }, 400);
      }
      const bucket = await uploadsBucket();
      const exists = await bucket.head(requestedPhotoKey);
      if (!exists) {
        return jsonResponse({ error: "A FOTO ENVIADA EXPIROU. TENTE NOVAMENTE." }, 400);
      }
      photoKey = requestedPhotoKey;
    }

    const controllers = category === "console" ? parseControllers(body.controllers) : [];
    if (typeof controllers === "string") {
      return jsonResponse({ error: controllers }, 400);
    }

    const database = await getD1();
    const originCompanyName = await companyName(database, originCompanyId);
    if (!originCompanyName) {
      return jsonResponse({ error: "LOJA DE ORIGEM NÃO ENCONTRADA." }, 400);
    }

    const id = crypto.randomUUID();
    await insertCaptureRow(database, {
      id,
      category,
      productName,
      gameName: category === "jogo" ? gameName : "",
      gameConsole: category === "jogo" ? gameConsole : "",
      gameCondition: category === "jogo" ? gameCondition : "",
      serialNumber,
      defects,
      color,
      originCompanyId,
      originCompanyName,
      capturedValueCents,
      photoKey,
      parentCaptureId: "",
      createdBy: actor.id,
      createdByName: actor.displayName,
    });
    for (const controller of controllers) {
      await insertCaptureRow(database, {
        id: crypto.randomUUID(),
        category: "controller",
        productName: controller.productName,
        gameName: "",
        gameConsole: "",
        gameCondition: "",
        serialNumber: controller.serialNumber,
        defects: controller.defects,
        color: controller.color,
        originCompanyId,
        originCompanyName,
        capturedValueCents: controller.capturedValueCents,
        photoKey: "",
        parentCaptureId: id,
        createdBy: actor.id,
        createdByName: actor.displayName,
      });
    }
    return liveCaptureResponse(
      { created: true, id },
      201,
      { originCompanyId, category },
    );
  } catch (error) {
    console.error("Não foi possível cadastrar o produto captado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O PRODUTO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const action = safeText(body.action, 40);
    if (!id) return jsonResponse({ error: "PRODUTO INVÁLIDO." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare(`${CAPTURE_SELECT} WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<CaptureRow>();
    if (!existing) return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);

    if (action === "receive" || action === "ready") {
      const allowedToReceive =
        actor.role !== "admin" &&
        (isAssistanceActor(actor) || actor.permissions.includes("captures:receive"));
      if (!allowedToReceive) {
        return jsonResponse(
          { error: "SOMENTE A ASSISTÊNCIA PODE ALTERAR ESTA ETAPA." },
          403,
        );
      }
      if (existing.category === "jogo") {
        return jsonResponse(
          { error: "JOGOS JÁ ENTRAM DISPONÍVEIS PARA SEPARAÇÃO." },
          409,
        );
      }
      if (existing.parentCaptureId) {
        return jsonResponse(
          {
            error:
              "ESTE CONTROLE ACOMPANHA O STATUS DO CONSOLE. USE A AÇÃO NO CONSOLE.",
          },
          409,
        );
      }
      if (action === "receive" && existing.status !== "submitted") {
        return jsonResponse(
          { error: "O PRODUTO PRECISA ESTAR AGUARDANDO A ASSISTÊNCIA." },
          409,
        );
      }
      if (action === "ready" && existing.status !== "received") {
        return jsonResponse(
          { error: "O PRODUTO PRECISA SER MARCADO COMO RECEBIDO PRIMEIRO." },
          409,
        );
      }
      if (action === "receive") {
        // Cascateia pros controles vinculados (parent_capture_id=id): eles
        // chegam e são testados junto com o console, então avançam de etapa
        // juntos até a definição de destino (ver captures/shared.ts).
        await database
          .prepare(
            `UPDATE captured_products
             SET status='received', received_by=?1, received_by_name=?2,
                 received_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
             WHERE id=?3 OR parent_capture_id=?3`,
          )
          .bind(actor.id, actor.displayName, id)
          .run();
      } else {
        await database
          .prepare(
            `UPDATE captured_products
             SET status='ready', ready_by=?1, ready_by_name=?2,
                 ready_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
             WHERE id=?3 OR parent_capture_id=?3`,
          )
          .bind(actor.id, actor.displayName, id)
          .run();
      }
      return liveCaptureResponse(
        {
          updated: true,
          status: action === "receive" ? "received" : "ready",
        },
        200,
        existing,
      );
    }

    if (action === "assign") {
      if (!can(actor, "captures:assign")) {
        return jsonResponse(
          { error: "VOCÊ NÃO TEM PERMISSÃO PARA DEFINIR O DESTINO." },
          403,
        );
      }
      if (existing.status !== "ready") {
        return jsonResponse(
          { error: "O PRODUTO AINDA NÃO ESTÁ DISPONÍVEL PARA SEPARAÇÃO." },
          409,
        );
      }
      const destinationCompanyId = safeText(body.destinationCompanyId, 80);
      if (!COMPANY_PATTERN.test(destinationCompanyId)) {
        return jsonResponse({ error: "ESCOLHA A LOJA DE DESTINO." }, 400);
      }
      const destinationCompanyName = await companyName(
        database,
        destinationCompanyId,
      );
      if (!destinationCompanyName) {
        return jsonResponse({ error: "LOJA DE DESTINO NÃO ENCONTRADA." }, 400);
      }
      await database
        .prepare(
          `UPDATE captured_products
           SET status='assigned', destination_company_id=?1,
               destination_company_name=?2, assigned_by=?3,
               assigned_by_name=?4, assigned_at=CURRENT_TIMESTAMP,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=?5`,
        )
        .bind(
          destinationCompanyId,
          destinationCompanyName,
          actor.id,
          actor.displayName,
          id,
        )
        .run();
      return liveCaptureResponse(
        {
          updated: true,
          status: "assigned",
          destinationCompanyId,
          destinationCompanyName,
        },
        200,
        existing,
      );
    }

    return jsonResponse({ error: "AÇÃO DE CAPTAÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível atualizar a captação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A CAPTAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "captures:delete")) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR CAPTAÇÕES." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "PRODUTO INVÁLIDO." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare(`${CAPTURE_SELECT} WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<CaptureRow>();
    if (!existing) {
      return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);
    }

    await database
      .prepare("DELETE FROM captured_products WHERE id=?1 OR parent_capture_id=?1")
      .bind(id)
      .run();

    if (existing.photoKey && isValidPhotoKey(existing.photoKey)) {
      try {
        const bucket = await uploadsBucket();
        await bucket.delete(existing.photoKey);
      } catch (error) {
        console.error("Não foi possível remover a foto da captação excluída.", error);
      }
    }

    return liveCaptureResponse({ deleted: true, id }, 200, existing);
  } catch (error) {
    console.error("Não foi possível excluir a captação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A CAPTAÇÃO." }, 500);
  }
}
