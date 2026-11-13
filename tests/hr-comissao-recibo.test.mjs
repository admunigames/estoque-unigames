import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Comissionamento (13/11/2026): cada linha traz CARGO, LOJA ATUANTE do mês,
// EMPRESA DE ADMISSÃO e o CNPJ dela (cadastro de lojas); a tela filtra por
// nome/cargo/loja/admissão e gera RECIBOS EM LOTE dos filtrados, no modelo
// novo (sem a legenda de natureza salarial, com assinatura e data à caneta).

const db = await setupRouteDb(["shared_state", "hr_employees", "hr_commissions", "hr_commission_items", "hr_schedule_assignments", "hr_payroll_settings"]);
const route = await import("../app/api/hr-payroll/commissions/route.ts");
const PAYROLL = { id: "rh", role: "admin" };
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([
    { id: "cguara", name: "GUARARAPES", cnpj: "59.601.284/0001-14", legalName: "UNIGAMES COMERCIO LTDA" },
    { id: "ctaca", name: "TACARUNA", cnpj: "" },
  ]),
});
db.insert("hr_employees", { id: "e1", full_name: "ANA", company_id: "ctaca", company_name: "TACARUNA", admission_company_id: "cguara", admission_company_name: "GUARARAPES", role_title: "VENDEDOR" });
db.insert("hr_schedule_assignments", { id: "a1", employee_id: "e1", employee_name: "ANA", company_id: "ctaca", company_name: "TACARUNA", reference_month: "2026-08" });
db.insert("hr_commissions", { id: "c1", employee_id: "e1", employee_name: "ANA", company_id: "cguara", company_name: "GUARARAPES", month: "2026-09", commission_cents: 10_000 });

test("linha do comissionamento: cargo, loja atuante, empresa de admissão e CNPJ", async () => {
  const response = await callRoute(route.GET, PAYROLL, "GET", "/api/hr-payroll/commissions?month=2026-09");
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const [row] = (await response.json()).commissions;
  assert.deepEqual(
    [row.roleTitle, row.actingCompanyName, row.admissionCompanyId, row.admissionCompanyName, row.admissionCnpj, row.admissionLegalName],
    ["VENDEDOR", "TACARUNA", "cguara", "GUARARAPES", "59601284000114", "UNIGAMES COMERCIO LTDA"],
  );
});

test("tela: colunas na ordem pedida, filtros, recibos em lote e recibo sem a legenda de natureza salarial", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /<th>Funcionário<\/th><th>Cargo<\/th><th>Loja atuante<\/th><th>Loja de admissão<\/th><th>Comissão<\/th><th>Bônus<\/th><th>Premiações<\/th><th>Descontos<\/th><th>Ajustes<\/th><th>Valor final<\/th>/);
  for (const id of ["rhComissaoBusca", "rhComissaoCargo", "rhComissaoLoja", "rhComissaoAdmissao", "btnRhComissaoRecibos"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /printRhComissaoRecibos\(rows, 'recibos-comissao-'/);
  const recibo = html.slice(html.indexOf("function rhComissaoReciboHtml("), html.indexOf("function printRhComissaoRecibos("));
  assert.doesNotMatch(recibo, /natureza salarial/i);
  assert.match(recibo, /EMPRESA DE ADMISSÃO/);
  assert.match(recibo, /rhFormatCnpj\(row\.admissionCnpj\)/);
  assert.match(recibo, /ASSINATURA DO COLABORADOR/);
  assert.match(recibo, /DATA DE RECEBIMENTO/);
  assert.doesNotMatch(recibo, /LOJA ATUANTE|OBSERVAÇÕES|row\.notes/, "recibo só com a empresa de admissão, sem observação do lançamento");
  assert.match(html, /\.rh-recibo\{[^}]*break-inside:avoid/, "vários recibos por folha sem cortar um ao meio");
});

test("filtro de CARGO: com ou sem acento é o mesmo cargo (uma opção, mostrada com acento)", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  const grab = (marker) => {
    const start = html.indexOf(marker);
    let depth = 0, end = html.indexOf("{", start);
    for (; end < html.length; end++) {
      if (html[end] === "{") depth++;
      if (html[end] === "}" && --depth === 0) break;
    }
    return html.slice(start, end + 1);
  };
  const source = ["function normalizeSearchText(", "function rhCargoKey(", "function renderRhComissaoCargoOptions("].map(grab).join("\n");
  const run = new Function("rhComissoes", "rhFillSelect", `${source}; renderRhComissaoCargoOptions(); return rhCargoKey;`);
  let options = [];
  const rows = [{ roleTitle: "TECNICO" }, { roleTitle: "Técnico " }, { roleTitle: "VENDEDOR" }, { roleTitle: "" }];
  const key = run(rows, (_id, _first, list) => { options = list; });
  assert.deepEqual(options, [
    { value: "tecnico", label: "TÉCNICO" },
    { value: "vendedor", label: "VENDEDOR" },
    { value: "__none__", label: "SEM CARGO CADASTRADO" },
  ]);
  assert.equal(key("TÉCNICO"), key("tecnico  "));
});
