import { getD1 } from "../../../db";
import { loadStores } from "../inventario/shared";
import { recifeDate } from "../../lib/ordens-servico";
import { buildView, canFollow, canRegister, EMAILS_KEY, guard, jsonResponse, loadEmails, loadOrderRows, parseJson } from "./shared";

// Estoque > Recebimento (ver shared.ts).
//   GET → {orders, canRegister, canFollow, stores?, emails?, emailConfigured?}
//   GET ?resumo=1 → contadores da faixa de atenção do Início (1 consulta, sem itens)
//   PUT {emails: [3]} → configuração dos e-mails da nota (só quem acompanha)

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: Request) {
  const checked = guard(request);
  if ("error" in checked) return checked.error;
  const { actor, allStores } = checked;
  const database = await getD1();
  const follow = canFollow(actor);
  const rows = await loadOrderRows(database, actor, allStores);
  if (new URL(request.url).searchParams.get("resumo") === "1") {
    const today = recifeDate();
    const open = rows.filter((row) => row.status === "aguardando_chegada");
    const divergent = (row: (typeof rows)[number]) =>
      parseJson<{ divergence?: string }>(row.itemsJson).some((item) => item.divergence) || parseJson(row.extrasJson).length > 0;
    return jsonResponse({
      canFollow: follow,
      toReceive: open.filter((row) => !row.checkedAt).length,
      late: open.filter((row) => !row.checkedAt && row.expectedDate && row.expectedDate < today).length,
      arrived: open.filter((row) => row.checkedAt).length,
      divergent: open.filter((row) => row.checkedAt && divergent(row)).length,
    });
  }
  const orders = await buildView(database, rows, follow);
  return jsonResponse({
    orders,
    canRegister: canRegister(actor),
    canFollow: follow,
    ...(follow
      ? {
          stores: await loadStores(database),
          emails: await loadEmails(database),
          emailConfigured: Boolean(process.env.RESEND_RECEBIMENTO_API_KEY?.trim()),
        }
      : {}),
  });
}

export async function PUT(request: Request) {
  const checked = guard(request);
  if ("error" in checked) return checked.error;
  if (!canFollow(checked.actor)) return jsonResponse({ error: "SÓ QUEM ACOMPANHA O RECEBIMENTO ALTERA OS E-MAILS." }, 403);
  const body = (await request.json().catch(() => ({}))) as { emails?: unknown };
  const emails = Array.isArray(body.emails) ? body.emails.map((email) => String(email ?? "").trim().toLowerCase()) : [];
  if (emails.length !== 3 || !emails.every((email) => EMAIL.test(email) && email.length <= 120)) {
    return jsonResponse({ error: "INFORME OS 3 E-MAILS VÁLIDOS." }, 400);
  }
  const database = await getD1();
  await database
    .prepare(
      `INSERT INTO shared_state (state_key, value_json, version, updated_at) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (state_key) DO UPDATE SET value_json = excluded.value_json, version = shared_state.version + 1, updated_at = excluded.updated_at`,
    )
    .bind(EMAILS_KEY, JSON.stringify(emails), new Date().toISOString())
    .run();
  return jsonResponse({ emails });
}
