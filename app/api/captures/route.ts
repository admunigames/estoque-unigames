import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import {
  CAPTURE_SELECT,
  CAPTURE_STATUSES,
  COMPANY_PATTERN,
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
  type JsonMap,
} from "./shared";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
  }

  try {
    const database = await getD1();
    const allStores = actor.role === "admin" || isAssistanceActor(actor);
    if (!allStores && !COMPANY_PATTERN.test(actor.companyId)) {
      return jsonResponse(
        { error: "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA." },
        403,
      );
    }
    const result = allStores
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
  if (!canAccessCaptures(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO À CAPTAÇÃO." }, 403);
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
    const originCompanyId =
      actor.role === "admin" ? requestedOriginCompanyId : actor.companyId;
    if (!COMPANY_PATTERN.test(originCompanyId)) {
      return jsonResponse(
        {
          error:
            actor.role === "admin"
              ? "ESCOLHA A LOJA DE ORIGEM."
              : "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA.",
        },
        400,
      );
    }
    const category: CaptureCategory =
      body.category === "console" || body.category === "controller"
        ? body.category
        : "other";
    const productName = safeText(body.productName, 160);
    const serialNumber = safeText(body.serialNumber, 160);
    const defects = safeText(body.defects, 1200);
    const color = safeText(body.color, 120);
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
    const rawCapturedValue = Number(body.capturedValue);
    const capturedValue =
      Number.isFinite(rawCapturedValue) && rawCapturedValue > 0
        ? rawCapturedValue
        : 0;
    if (capturedValue > 999999.99) {
      return jsonResponse({ error: "VALOR CAPTADO INVÁLIDO." }, 400);
    }
    const capturedValueCents = Math.round(capturedValue * 100);
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

    const database = await getD1();
    const originCompanyName = await companyName(database, originCompanyId);
    if (!originCompanyName) {
      return jsonResponse({ error: "LOJA DE ORIGEM NÃO ENCONTRADA." }, 400);
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO captured_products
          (id, category, product_name, serial_number, defects, color,
           origin_company_id, origin_company_name, captured_value_cents,
           photo_key, status, created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'submitted',
                 ?11, ?12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        category,
        productName,
        serialNumber,
        defects,
        color,
        originCompanyId,
        originCompanyName,
        capturedValueCents,
        photoKey,
        actor.id,
        actor.displayName,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
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
      if (!isAssistanceActor(actor) || actor.role === "admin") {
        return jsonResponse(
          { error: "SOMENTE A ASSISTÊNCIA PODE ALTERAR ESTA ETAPA." },
          403,
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
        await database
          .prepare(
            `UPDATE captured_products
             SET status='received', received_by=?1, received_by_name=?2,
                 received_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
             WHERE id=?3`,
          )
          .bind(actor.id, actor.displayName, id)
          .run();
      } else {
        await database
          .prepare(
            `UPDATE captured_products
             SET status='ready', ready_by=?1, ready_by_name=?2,
                 ready_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
             WHERE id=?3`,
          )
          .bind(actor.id, actor.displayName, id)
          .run();
      }
      return jsonResponse({
        updated: true,
        status: action === "receive" ? "received" : "ready",
      });
    }

    if (action === "assign") {
      if (actor.role !== "admin") {
        return jsonResponse(
          { error: "SOMENTE O ADMINISTRADOR PODE DEFINIR O DESTINO." },
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
      return jsonResponse({
        updated: true,
        status: "assigned",
        destinationCompanyId,
        destinationCompanyName,
      });
    }

    return jsonResponse({ error: "AÇÃO DE CAPTAÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível atualizar a captação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A CAPTAÇÃO." }, 500);
  }
}
