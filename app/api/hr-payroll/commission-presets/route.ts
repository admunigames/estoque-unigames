import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  COMMISSION_KINDS,
  canManagePayroll,
  centsValue,
  actorName,
  identity,
  isOneOf,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Catálogo de lançamentos recorrentes do comissionamento (ex.: "Bônus GAR").
// Serve só para pré-preencher rótulo/tipo/valor de uma linha nova; a linha
// gravada (hr_commission_items) guarda a própria cópia desses dados, então
// editar ou excluir um preset nunca altera comissão já fechada.

type PresetRow = {
  id: string;
  name: string;
  kind: string;
  defaultAmountCents: number;
  active: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const PRESET_COLUMNS = `id, name, kind, default_amount_cents AS defaultAmountCents, active,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMISSIONAMENTO." }, 403);
  }

  const onlyActive = new URL(request.url).searchParams.get("onlyActive") === "1";
  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT ${PRESET_COLUMNS} FROM hr_commission_presets
         ${onlyActive ? "WHERE active=1" : ""} ORDER BY name ASC`,
      )
      .all<PresetRow>();
    return jsonResponse({ presets: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os lançamentos padrão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS LANÇAMENTOS PADRÃO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR LANÇAMENTOS PADRÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const name = safeText(body.name, 120);
    const kind = safeText(body.kind, 20);
    const defaultAmountCents = centsValue(body.defaultAmountCents ?? 0);
    const active = body.active === false ? 0 : 1;

    if (!name) return jsonResponse({ error: "INFORME O NOME DO LANÇAMENTO." }, 400);
    if (!isOneOf(COMMISSION_KINDS, kind)) {
      return jsonResponse({ error: "SELECIONE UM TIPO DE LANÇAMENTO VÁLIDO." }, 400);
    }
    if (!Number.isFinite(defaultAmountCents) || defaultAmountCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR PADRÃO VÁLIDO." }, 400);
    }

    const database = await getD1();
    const duplicate = await database
      .prepare("SELECT id FROM hr_commission_presets WHERE name=?1 AND id<>?2 LIMIT 1")
      .bind(name, editId || "")
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse({ error: "JÁ EXISTE UM LANÇAMENTO PADRÃO COM ESSE NOME." }, 409);
    }

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_commission_presets WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "LANÇAMENTO PADRÃO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_commission_presets
           SET name=?1, kind=?2, default_amount_cents=?3, active=?4, updated_by=?5,
               updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
           WHERE id=?7`,
        )
        .bind(name, kind, defaultAmountCents, active, actor.id, actorName(actor), editId)
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_commission_presets
          (id, name, kind, default_amount_cents, active, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP)`,
      )
      .bind(id, name, kind, defaultAmountCents, active, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o lançamento padrão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O LANÇAMENTO PADRÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR LANÇAMENTOS PADRÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO PADRÃO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    // As linhas já lançadas guardam rótulo/tipo/valor próprios, então excluir
    // o preset não altera nenhuma comissão fechada — só some do seletor.
    await database.batch([
      database.prepare("DELETE FROM hr_commission_presets WHERE id=?1").bind(id),
      database.prepare("UPDATE hr_commission_items SET preset_id='' WHERE preset_id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento padrão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO PADRÃO." }, 500);
  }
}
