import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Recrutamento: CADASTRO EM LOTE de candidatos (25/11/2026).

const db = await setupRouteDb(["hr_recruitment_candidates", "hr_recruitment_status_history", "app_users", "shared_state"]);
const batch = await import("../app/api/hr-recruitment/candidates/batch/route.ts");
const ADMIN = { id: "admin", role: "admin", name: "LIDIANE" };
const post = (body, actor = ADMIN) => callRoute(batch.POST, actor, "POST", "/api/hr-recruitment/candidates/batch", body);

test("cadastra todos de uma vez, em CAIXA ALTA, com histórico de status", async () => {
  const response = await post({
    status: "selecionado_entrevista",
    items: [
      { fullName: "maria da silva", phone: "(81) 99999-0000", desiredRole: "vendedor", interviewDate: "2026-11-27", interviewTime: "14:30" },
      { fullName: "João Santos", phone: "81988887777" },
    ],
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  assert.deepEqual(await response.json(), { created: 2 });
  const rows = db.sqlite.prepare("SELECT full_name, phone, desired_role, status, interview_date, interview_time, created_by FROM hr_recruitment_candidates ORDER BY full_name").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { full_name: "JOÃO SANTOS", phone: "81988887777", desired_role: "", status: "selecionado_entrevista", interview_date: "", interview_time: "", created_by: "admin" },
    { full_name: "MARIA DA SILVA", phone: "(81) 99999-0000", desired_role: "vendedor", status: "selecionado_entrevista", interview_date: "2026-11-27", interview_time: "14:30", created_by: "admin" },
  ]);
  const history = db.sqlite.prepare("SELECT to_status, note FROM hr_recruitment_status_history").all().map((row) => ({ ...row }));
  assert.deepEqual(history, [
    { to_status: "selecionado_entrevista", note: "CADASTRO EM LOTE" },
    { to_status: "selecionado_entrevista", note: "CADASTRO EM LOTE" },
  ]);
});

test("recusa linha sem nome, status de contratação e quem não pode cadastrar — nada é gravado", async () => {
  const before = db.sqlite.prepare("SELECT COUNT(*) AS n FROM hr_recruitment_candidates").get().n;
  let response = await post({ items: [{ fullName: "OK" }, { fullName: " ", phone: "81" }] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /LINHA 2/);
  response = await post({ status: "contratado", items: [{ fullName: "X" }] });
  assert.equal(response.status, 400);
  response = await post({ items: [] });
  assert.equal(response.status, 400);
  response = await post({ items: [{ fullName: "X" }] }, { id: "u", permissions: ["rh_recrutamento:view"] });
  assert.equal(response.status, 403);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM hr_recruitment_candidates").get().n, before);
});

test("tela: botão, prévia e leitura da lista colada (NOME - CONTATO, planilha e telefone no fim)", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="btnRecBatch" type="button">CADASTRO EM LOTE<\/button>/);
  assert.match(html, /recApiRequest\('\/candidates\/batch'/);
  // Executa o leitor de linha do próprio HTML.
  const start = html.indexOf("  function recBatchParseLine(line){");
  const end = html.indexOf("  function recBatchParse(){");
  const recBatchDigits = (value) => String(value || "").replace(/\D+/g, "");
  const parse = new Function("recBatchDigits", `${html.slice(start, end)}; return recBatchParseLine;`)(recBatchDigits);
  assert.deepEqual(parse("Maria da Silva - (81) 99999-0000"), { fullName: "MARIA DA SILVA", phone: "(81) 99999-0000", desiredRole: "", interviewDate: "", interviewTime: "" });
  assert.deepEqual(parse("Ana Paula\t81 98888-7777\tVendedora\t27/11/2026\t9:30"), { fullName: "ANA PAULA", phone: "81 98888-7777", desiredRole: "VENDEDORA", interviewDate: "2026-11-27", interviewTime: "09:30" });
  assert.deepEqual(parse("JOÃO 81977776666"), { fullName: "JOÃO", phone: "81977776666", desiredRole: "", interviewDate: "", interviewTime: "" });
  assert.equal(parse("Ana-Clara Souza; 81966665555").fullName, "ANA-CLARA SOUZA");
});
