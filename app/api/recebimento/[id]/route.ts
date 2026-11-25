import { getD1 } from "../../../../db";
import { canActOnStore } from "../../../lib/access-scope";
import { recifeDate } from "../../../lib/ordens-servico";
import { contentDisposition, documentsBucket, safeR2FileName } from "../../documents/shared";
import { loadStores } from "../../inventario/shared";
import {
  ALL_STORES_PERMISSION, actorName, canFollow, canRegister, guard, jsonResponse, loadEmails, loadItems, loadOrder,
  NOT_FOUND, notifyFollowers, parseJson, resolveDivergence, safeText, upperNote,
  type Actor, type HistoryEntry,
} from "../shared";

// Estoque > Recebimento de um pedido (ver ../shared.ts).
//   GET ?anexo=                      → PDF de uma nota (só quem acompanha todas as lojas)
//   POST ?nfNumber= corpo application/pdf → envia uma NF (anexo 'nota_fiscal' + e-mail + aviso).
//        Pode haver mais de uma NF por compra (números diferentes), até o Compras concluir.
//   POST {action:"conferir", items:[{itemId, counted, divergence, note}], extras:[{productName, quantity, note}]}
//   POST {action:"corrigir", itemId, counted, divergence?, note?, reason}
//   POST {action:"loja", companyId}  → troca a loja de chegada (só quem acompanha)
// Nada aqui muda o status do pedido: quem conclui é sempre o Compras.

type Params = { params: Promise<{ id: string }> };
type Db = Awaited<ReturnType<typeof getD1>>;
type Order = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
type ReceiptItem = { itemId: string; counted: number; divergence: string; note: string };

const MAX_PDF = 15 * 1024 * 1024;
const MAX_QTY = 100000;
const EMAIL_FROM = "Unigames Recebimento <recebimento@unigameslojas.com>";
const LOCKED = "ESTA COMPRA JÁ FOI CONCLUÍDA PELO COMPRAS E NÃO PODE SER ALTERADA.";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string);
const validQty = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_QTY;
const entry = (actor: Actor, type: string, extra: Record<string, unknown> = {}): HistoryEntry =>
  ({ at: new Date().toISOString(), type, byId: actor.id, byName: actorName(actor), ...extra });

/**
 * Grava a linha do recebimento com trava otimista (version). Retorna a nova
 * version, ou 0 se outra pessoa gravou antes (o chamador responde 409).
 */
async function writeReceipt(db: Db, order: Order, set: Record<string, string>): Promise<number> {
  const columns = Object.keys(set);
  const values = Object.values(set);
  if (order.version === null) {
    const row = await db
      .prepare(
        `INSERT INTO purchase_receipts (order_id, ${columns.join(", ")})
         VALUES (?1, ${columns.map((_, i) => `?${i + 2}`).join(", ")})
         ON CONFLICT (order_id) DO NOTHING RETURNING order_id AS orderId`,
      )
      .bind(order.id, ...values)
      .first();
    return row ? 1 : 0;
  }
  const n = columns.length;
  const row = await db
    .prepare(
      `UPDATE purchase_receipts SET ${columns.map((column, i) => `${column} = ?${i + 1}`).join(", ")},
         version = version + 1, updated_at = ?${n + 1}
       WHERE order_id = ?${n + 2} AND version = ?${n + 3} RETURNING order_id AS orderId`,
    )
    .bind(...values, new Date().toISOString(), order.id, order.version)
    .first();
  return row ? order.version + 1 : 0;
}

const CONFLICT = () => jsonResponse({ error: "OUTRA PESSOA ALTEROU ESTA COMPRA AGORA. ATUALIZE A PÁGINA E TENTE DE NOVO." }, 409);

async function start(request: Request, context: Params) {
  const checked = guard(request);
  if ("error" in checked) return { error: checked.error };
  const { id } = await context.params;
  const database = await getD1();
  const order = await loadOrder(database, checked.actor, safeText(id, 80));
  if (!order) return { error: jsonResponse({ error: NOT_FOUND }, 404) };
  return { actor: checked.actor, database, order };
}

export async function GET(request: Request, context: Params) {
  const started = await start(request, context);
  if ("error" in started) return started.error;
  const { actor, database, order } = started;
  // A NF tem preços: só o Compras (acompanha todas as lojas) abre o PDF.
  if (!canFollow(actor)) return jsonResponse({ error: "SÓ O COMPRAS ABRE O PDF DA NOTA." }, 403);
  const wanted = safeText(new URL(request.url).searchParams.get("anexo"), 80) || order.nfAttachmentId || "";
  const sentByStore = parseJson<HistoryEntry>(order.historyJson).some((h) => h.type === "nota" && h.attachmentId === wanted);
  const attachment = wanted && (sentByStore || wanted === order.nfAttachmentId)
    ? await database
        .prepare("SELECT r2_key AS r2Key, file_name AS fileName FROM purchase_order_attachments WHERE id=?1 AND order_id=?2 AND attachment_type='nota_fiscal'")
        .bind(wanted, order.id)
        .first<{ r2Key: string; fileName: string }>()
    : null;
  if (!attachment) return jsonResponse({ error: "A NOTA NÃO ESTÁ MAIS ANEXADA AO PEDIDO." }, 404);
  const object = await (await documentsBucket()).get(attachment.r2Key);
  if (!object) return jsonResponse({ error: "ARQUIVO DA NOTA NÃO ENCONTRADO." }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(attachment.fileName, false),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(request: Request, context: Params) {
  const started = await start(request, context);
  if ("error" in started) return started.error;
  const { actor, database, order } = started;
  if ((request.headers.get("content-type") || "").startsWith("application/pdf")) return sendNota(request, actor, database, order);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action === "loja") return changeStore(body, actor, database, order);
  if (!canRegister(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR O RECEBIMENTO." }, 403);
  if (order.status !== "aguardando_chegada") return jsonResponse({ error: LOCKED }, 409);
  if (body.action === "conferir") return check(body, actor, database, order);
  if (body.action === "corrigir") return correct(body, actor, database, order);
  return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
}

async function sendNota(request: Request, actor: Actor, database: Db, order: Order) {
  if (!canRegister(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ENVIAR A NOTA." }, 403);
  if (order.status !== "aguardando_chegada") return jsonResponse({ error: LOCKED }, 409);
  const nfNumber = String(new URL(request.url).searchParams.get("nfNumber") || "").replace(/\D/g, "").slice(0, 15);
  if (!nfNumber) return jsonResponse({ error: "INFORME O NÚMERO DA NOTA." }, 400);
  const history = parseJson<HistoryEntry>(order.historyJson);
  const sentNumbers = history.filter((h) => h.type === "nota").map((h) => String(h.nfNumber));
  if (sentNumbers.includes(nfNumber)) return jsonResponse({ error: `A NF ${nfNumber} JÁ FOI ENVIADA NESTA COMPRA.` }, 409);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) return jsonResponse({ error: "ESCANEIE OU ANEXE A NOTA." }, 400);
  if (bytes.byteLength > MAX_PDF) return jsonResponse({ error: "O PDF DEVE TER NO MÁXIMO 15 MB." }, 400);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return jsonResponse({ error: "O ARQUIVO PRECISA SER UM PDF." }, 400);

  const storeName = (order.deliveryCompanyName || order.companyName).toLocaleUpperCase("pt-BR");
  const fileName = `NF-${nfNumber}-${storeName.replace(/[^A-Z0-9]+/g, "-")}.pdf`;
  const attachmentId = crypto.randomUUID();
  const r2Key = `purchase-orders/${order.id}/${attachmentId}-${safeR2FileName(fileName)}`;
  const bucket = await documentsBucket();
  await bucket.put(r2Key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const by = actorName(actor);
  const now = new Date().toISOString();
  // Mesmo anexo "NOTA FISCAL (ARQUIVO)" do Compras — é o tipo que o Financeiro copia para a NF.
  await database
    .prepare(
      `INSERT INTO purchase_order_attachments
        (id, order_id, attachment_type, r2_key, file_name, content_type, size_bytes, uploaded_by, uploaded_by_name, created_at)
       VALUES (?1, ?2, 'nota_fiscal', ?3, ?4, 'application/pdf', ?5, ?6, ?7, ?8)`,
    )
    .bind(attachmentId, order.id, r2Key, fileName, bytes.byteLength, actor.id, by, now)
    .run();
  history.push(entry(actor, "nota", { nfNumber, attachmentId, fileName }));
  // nf_sent_* / nf_attachment_id = 1ª NF (abre a conferência); nf_number = todas, separadas por vírgula.
  const first = !order.nfSentAt;
  const version = await writeReceipt(database, order, {
    nf_number: [...sentNumbers, nfNumber].join(", "),
    ...(first ? { nf_attachment_id: attachmentId, nf_sent_by: actor.id, nf_sent_by_name: by, nf_sent_at: now } : {}),
    history_json: JSON.stringify(history),
  });
  if (!version) {
    await database.prepare("DELETE FROM purchase_order_attachments WHERE id=?1").bind(attachmentId).run();
    await bucket.delete(r2Key).catch(() => undefined);
    return CONFLICT();
  }

  const supplier = await supplierName(database, order);
  const email = await sendEmail(database, { storeName, supplier, nfNumber, by, fileName, bytes, orderDate: order.orderDate });
  history.push(entry(actor, "email", email));
  await writeReceipt(database, { ...order, version }, { history_json: JSON.stringify(history) });
  await notifyFollowers(database, order.id, "NOTA RECEBIDA", `${storeName} ENVIOU A NF ${nfNumber} · ${supplier}`);
  return jsonResponse({ ok: true, emailSent: email.ok }, 201);
}

async function supplierName(database: Db, order: Order) {
  const row = order.supplierId
    ? await database.prepare("SELECT name FROM finance_suppliers WHERE id=?1").bind(order.supplierId).first<{ name: string }>()
    : null;
  return String(row?.name || order.supplierNameRaw || String(order.notes || "").split("\n")[0] || "FORNECEDOR").toLocaleUpperCase("pt-BR");
}

async function sendEmail(
  database: Db,
  nota: { storeName: string; supplier: string; nfNumber: string; by: string; fileName: string; bytes: Uint8Array; orderDate: string },
) {
  const emails = await loadEmails(database);
  const [to, ...cc] = emails;
  const key = process.env.RESEND_RECEBIMENTO_API_KEY?.trim();
  if (!key) return { ok: false, to, cc, error: "ENVIO DE E-MAIL NÃO CONFIGURADO (RESEND_RECEBIMENTO_API_KEY)." };
  const dateBR = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        cc,
        subject: `CHEGADA DE COMPRA · ${nota.storeName} · ${nota.supplier} · NF ${nota.nfNumber}`,
        html:
          `<p><b>LOJA:</b> ${escapeHtml(nota.storeName)}<br><b>FORNECEDOR:</b> ${escapeHtml(nota.supplier)}<br>` +
          `<b>NF:</b> ${nota.nfNumber}<br>${nota.orderDate ? `<b>PEDIDO DE:</b> ${dateBR(nota.orderDate)}<br>` : ""}` +
          `<b>ENVIADO POR:</b> ${escapeHtml(nota.by)}<br><b>ENVIADO EM:</b> ${dateBR(recifeDate())}</p>` +
          `<p>PDF DA NOTA EM ANEXO. A CONFERÊNCIA DAS QUANTIDADES É FEITA EM SEGUIDA NO SISTEMA.</p>`,
        attachments: [{ filename: nota.fileName, content: Buffer.from(nota.bytes).toString("base64") }],
      }),
    });
    const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (response.ok && result.id) return { ok: true, to, cc, emailId: result.id };
    console.error("Resend recusou o e-mail do recebimento.", response.status, result.message);
    return { ok: false, to, cc, error: `RESEND RECUSOU (${response.status}).` };
  } catch (error) {
    console.error("Falha ao enviar o e-mail do recebimento.", error);
    return { ok: false, to, cc, error: "FALHA DE CONEXÃO COM O RESEND." };
  }
}

async function check(body: Record<string, unknown>, actor: Actor, database: Db, order: Order) {
  if (!order.nfSentAt) return jsonResponse({ error: "ENVIE A NOTA ANTES DE CONFERIR." }, 409);
  if (order.checkedAt) return jsonResponse({ error: "CONFERÊNCIA JÁ REGISTRADA. USE CORRIGIR." }, 409);
  const sent = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  const items = await loadItems(database, [order.id]);
  const counts: ReceiptItem[] = [];
  for (const item of items) {
    const row = sent.find((candidate) => candidate && candidate.itemId === item.id);
    const counted = row ? Number(row.counted) : NaN;
    if (!row || row.counted === "" || row.counted === null || !validQty(counted)) {
      return jsonResponse({ error: `INFORME A QUANTIDADE DE ${item.productName || item.productCode} (MESMO QUE 0).` }, 400);
    }
    const note = upperNote(row.note);
    const result = resolveDivergence(counted, Number(item.quantity), row.divergence, note);
    if (result.error) return jsonResponse({ error: `${item.productName || item.productCode}: ${result.error}` }, 400);
    counts.push({ itemId: item.id, counted, divergence: result.divergence, note });
  }
  const rawExtras = Array.isArray(body.extras) ? (body.extras as Record<string, unknown>[]) : [];
  if (rawExtras.length > 50) return jsonResponse({ error: "NO MÁXIMO 50 PRODUTOS FORA DO PEDIDO." }, 400);
  const extras = [];
  for (const extra of rawExtras) {
    const productName = upperNote(extra?.productName, 200);
    const quantity = Number(extra?.quantity);
    if (!productName || !validQty(quantity) || quantity < 1) return jsonResponse({ error: "INFORME O PRODUTO E A QUANTIDADE QUE CHEGOU FORA DO PEDIDO." }, 400);
    extras.push({ productName, quantity, note: upperNote(extra?.note) });
  }

  const divergences = counts.filter((count) => count.divergence).length + extras.length;
  const history = parseJson<HistoryEntry>(order.historyJson);
  history.push(entry(actor, "conferencia", { divergences }));
  const by = actorName(actor);
  const version = await writeReceipt(database, order, {
    checked_by: actor.id, checked_by_name: by, checked_at: new Date().toISOString(),
    items_json: JSON.stringify(counts), extras_json: JSON.stringify(extras), history_json: JSON.stringify(history),
  });
  if (!version) return CONFLICT();
  // Mesmos campos do Compras: QTD RECEBIDA (a real, pode passar do pedido)
  // e a data de recebimento. O status NÃO muda.
  await database.batch([
    ...items.map((item) => {
      const count = counts.find((candidate) => candidate.itemId === item.id) as ReceiptItem;
      return database
        .prepare(
          `UPDATE purchase_order_items SET received_quantity = ?1, updated_by = ?2, updated_by_name = ?3, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?4 AND order_id = ?5`,
        )
        .bind(count.counted, actor.id, by, item.id, order.id);
    }),
    database.prepare("UPDATE purchase_orders SET received_date = ?1 WHERE id = ?2 AND received_date = ''").bind(recifeDate(), order.id),
  ]);
  const storeName = order.deliveryCompanyName || order.companyName;
  const supplier = await supplierName(database, order);
  await notifyFollowers(
    database, order.id,
    divergences ? "CHEGOU COM DIVERGÊNCIA" : "COMPRA CHEGOU",
    `${storeName} · ${supplier} · NF ${order.nfNumber} — ${divergences ? `${divergences} DIVERGÊNCIA(S)` : "TUDO CONFERE"}.`,
  );
  return jsonResponse({ ok: true, divergences });
}

async function correct(body: Record<string, unknown>, actor: Actor, database: Db, order: Order) {
  if (!order.checkedAt) return jsonResponse({ error: "REGISTRE A CONFERÊNCIA PRIMEIRO." }, 409);
  const item = (await loadItems(database, [order.id])).find((candidate) => candidate.id === body.itemId);
  if (!item) return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO NESTA COMPRA." }, 404);
  const counted = Number(body.counted);
  if (body.counted === "" || body.counted === null || !validQty(counted)) return jsonResponse({ error: "INFORME A QUANTIDADE CORRETA." }, 400);
  const reason = upperNote(body.reason);
  if (reason.length < 5) return jsonResponse({ error: "INFORME O MOTIVO DA CORREÇÃO." }, 400);
  const counts = parseJson<ReceiptItem>(order.itemsJson);
  const previous = counts.find((candidate) => candidate.itemId === item.id);
  const note = body.note === undefined ? previous?.note || "" : upperNote(body.note);
  // Sem divergência nova escolhida: mantém a marcada pela loja, senão recalcula pela contagem.
  const chosen = body.divergence === undefined
    ? (previous && !["faltou", "veio_a_mais", ""].includes(previous.divergence) ? previous.divergence : "")
    : body.divergence;
  const result = resolveDivergence(counted, Number(item.quantity), chosen, note);
  if (result.error) return jsonResponse({ error: result.error }, 400);
  const updated = { itemId: item.id, counted, divergence: result.divergence, note };
  const nextCounts = previous ? counts.map((candidate) => (candidate.itemId === item.id ? updated : candidate)) : [...counts, updated];
  const history = parseJson<HistoryEntry>(order.historyJson);
  history.push(entry(actor, "correcao", {
    itemId: item.id, productName: item.productName, from: previous ? previous.counted : null, to: counted, reason,
  }));
  const version = await writeReceipt(database, order, { items_json: JSON.stringify(nextCounts), history_json: JSON.stringify(history) });
  if (!version) return CONFLICT();
  await database
    .prepare(
      `UPDATE purchase_order_items SET received_quantity = ?1, updated_by = ?2, updated_by_name = ?3, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?4 AND order_id = ?5`,
    )
    .bind(counted, actor.id, actorName(actor), item.id, order.id)
    .run();
  const storeName = order.deliveryCompanyName || order.companyName;
  await notifyFollowers(database, order.id, "QUANTIDADE CORRIGIDA", `${storeName} · ${item.productName}: AGORA ${counted}. MOTIVO: ${reason}`);
  return jsonResponse({ ok: true });
}

async function changeStore(body: Record<string, unknown>, actor: Actor, database: Db, order: Order) {
  if (!canFollow(actor)) return jsonResponse({ error: "SÓ O COMPRAS TROCA A LOJA DE CHEGADA." }, 403);
  if (order.status !== "aguardando_chegada") return jsonResponse({ error: LOCKED }, 409);
  const companyId = safeText(body.companyId, 80);
  const store = companyId === order.companyId
    ? { id: order.companyId, name: order.companyName }
    : (await loadStores(database)).find((candidate) => candidate.id === companyId);
  if (!store || !canActOnStore(actor, ALL_STORES_PERMISSION, store.id)) return jsonResponse({ error: "ESCOLHA A LOJA DE CHEGADA." }, 400);
  const current = order.deliveryCompanyId || order.companyId;
  if (store.id === current) return jsonResponse({ error: "ESTA JÁ É A LOJA DE CHEGADA." }, 400);
  const history = parseJson<HistoryEntry>(order.historyJson);
  history.push(entry(actor, "loja", {
    from: order.deliveryCompanyName || order.companyName, to: String(store.name).toLocaleUpperCase("pt-BR"),
  }));
  const isBilling = store.id === order.companyId;
  const version = await writeReceipt(database, order, {
    delivery_company_id: isBilling ? "" : store.id,
    delivery_company_name: isBilling ? "" : String(store.name).toLocaleUpperCase("pt-BR"),
    history_json: JSON.stringify(history),
  });
  if (!version) return CONFLICT();
  return jsonResponse({ ok: true });
}
