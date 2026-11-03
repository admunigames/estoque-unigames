import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canActOnStore, resolveStoreScope } from "../../lib/access-scope";
import { recifeDate } from "../../lib/ordens-servico";
import { identity, jsonResponse, safeText, sameOrigin } from "../divergences/shared";
import { loadStores } from "../inventario/shared";

// Estoque > Relatórios Logística (permissões relatorios_logistica:view/send).
// A loja escolhe a data do relatório e manda o PDF (anexado ou montado das
// fotos no navegador); o PDF vai DIRETO para o e-mail da logística pelo
// Resend e não é guardado — no banco fica só o registro do envio.
// Login com loja só envia/vê a própria loja; sem loja vê todas.
//   GET                                   → {stores, reports, emailTo, configured}
//   POST ?companyId=&reportDate=&fileName=  corpo application/pdf → envia

export const EMAIL_TO = "estoque.unigames@gmail.com";
// Sem domínio próprio o Resend só entrega para o e-mail dono da conta
// (a conta do Resend é a do EMAIL_TO).
const EMAIL_FROM = "Unigames Estoque <onboarding@resend.dev>";
const MAX_SIZE = 15 * 1024 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Actor = ReturnType<typeof identity>;

const can = (actor: Actor, action: string) =>
  actor.role === "admin" || actor.permissions.includes(`relatorios_logistica:${action}`);
const scope = (actor: Actor) => resolveStoreScope(actor, "relatorios_logistica:view");
const dateBR = (iso: string) => iso.split("-").reverse().join("/");
const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string);

function guard(request: Request, action: string) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!can(actor, action) && !(action === "view" && can(actor, "send"))) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA OS RELATÓRIOS DA LOGÍSTICA." }, 403) };
  }
  if (request.method !== "GET" && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  const storeScope = scope(actor);
  if (storeScope.blocked) return { error: jsonResponse({ error: "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA." }, 403) };
  return { actor, allStores: storeScope.allStores };
}

export async function GET(request: Request) {
  const checked = guard(request, "view");
  if ("error" in checked) return checked.error;
  const { actor, allStores } = checked;
  const database = await getD1();
  const stores = (await loadStores(database)).filter((store) => allStores || store.id === actor.companyId);
  const select = `SELECT id, company_id AS companyId, company_name AS companyName, report_date AS reportDate, file_name AS fileName,
    file_size AS fileSize, email_to AS emailTo, sent_by_name AS sentByName, sent_at AS sentAt FROM logistics_reports`;
  const { results } = allStores
    ? await database.prepare(`${select} ORDER BY sent_at DESC LIMIT 500`).all()
    : await database.prepare(`${select} WHERE company_id=?1 ORDER BY sent_at DESC LIMIT 500`).bind(actor.companyId).all();
  return jsonResponse({
    stores, reports: results, emailTo: EMAIL_TO, configured: Boolean(process.env.RESEND_API_KEY?.trim()),
    canSend: can(actor, "send"),
  });
}

export async function POST(request: Request) {
  const checked = guard(request, "send");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  if (!can(actor, "send")) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ENVIAR RELATÓRIOS." }, 403);
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return jsonResponse({ error: "O ENVIO DE E-MAIL AINDA NÃO FOI CONFIGURADO (RESEND_API_KEY)." }, 503);

  const url = new URL(request.url);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const reportDate = safeText(url.searchParams.get("reportDate"), 10);
  if (!DATE.test(reportDate) || reportDate > recifeDate()) return jsonResponse({ error: "INFORME A DATA DO RELATÓRIO (NÃO PODE SER FUTURA)." }, 400);
  const database = await getD1();
  const store = (await loadStores(database)).find((item) => item.id === companyId);
  if (!store || !canActOnStore(actor, "relatorios_logistica:view", store.id)) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) return jsonResponse({ error: "ANEXE O PDF OU ESCANEIE O RELATÓRIO." }, 400);
  if (bytes.byteLength > MAX_SIZE) return jsonResponse({ error: "O PDF DEVE TER NO MÁXIMO 15 MB." }, 400);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return jsonResponse({ error: "O ARQUIVO PRECISA SER UM PDF." }, 400);

  const storeName = String(store.name).toLocaleUpperCase("pt-BR");
  const fileName = `RELATORIO-LOGISTICA-${storeName.replace(/[^A-Z0-9]+/g, "-")}-${reportDate}.pdf`;
  const original = safeText(url.searchParams.get("fileName"), 200);
  const sentAt = new Date().toISOString();
  const sender = actor.displayName || actor.id;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject: `RELATÓRIO LOGÍSTICA - ${storeName} - ${dateBR(reportDate)}`,
      html: `<p><b>LOJA:</b> ${escapeHtml(storeName)}<br><b>DATA DO RELATÓRIO:</b> ${dateBR(reportDate)}<br>` +
        `<b>ENVIADO POR:</b> ${escapeHtml(sender)}<br><b>ENVIADO EM:</b> ${dateBR(recifeDate(sentAt))}</p>` +
        (original ? `<p>ARQUIVO ORIGINAL: ${escapeHtml(original)}</p>` : ""),
      attachments: [{ filename: fileName, content: Buffer.from(bytes).toString("base64") }],
    }),
  });
  const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok || !result.id) {
    console.error("Resend recusou o relatório da logística.", response.status, result.message);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENVIAR O E-MAIL. TENTE NOVAMENTE." }, 502);
  }

  const id = crypto.randomUUID();
  await database
    .prepare(`INSERT INTO logistics_reports (id, company_id, company_name, report_date, file_name, file_size, email_to, email_id, sent_by, sent_by_name, sent_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
    .bind(id, store.id, storeName, reportDate, fileName, bytes.byteLength, EMAIL_TO, result.id, actor.id, sender, sentAt)
    .run();
  return jsonResponse({ id, emailTo: EMAIL_TO, fileName }, 201);
}
