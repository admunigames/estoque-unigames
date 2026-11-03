import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Todo INSERT escrito à mão precisa ter o MESMO número de colunas e de valores.
// Em 03/11/2026 dois estavam com um valor a menos desde setembro: nenhum
// benefício MANUAL nem Acompanhamento - Lojas conseguia ser salvo (o erro só
// aparecia como "NÃO FOI POSSÍVEL SALVAR..."). Este teste varre app/, db/ e
// worker/ e falha se aparecer outro.

const ROOT = new URL("..", import.meta.url).pathname;

function tsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : tsFiles(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

/** Separa por vírgula no nível de cima (ignora vírgulas dentro de parênteses). */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

test("INSERT ... (colunas) VALUES (...): mesma quantidade de colunas e de valores em todas as rotas", () => {
  const problems = [];
  let checked = 0;
  for (const file of ["app", "db", "worker"].flatMap((dir) => tsFiles(join(ROOT, dir)))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/INSERT INTO\s+"?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*\(/gi)) {
      let index = match.index + match[0].length;
      let depth = 1;
      let values = "";
      while (index < source.length && depth) {
        const char = source[index++];
        if (char === "(") depth++;
        if (char === ")") depth--;
        if (depth) values += char;
      }
      if (/\$\{/.test(match[2] + values)) continue; // montado dinamicamente
      checked++;
      const columns = splitTop(match[2]).length;
      const count = splitTop(values).length;
      if (columns !== count) {
        const line = source.slice(0, match.index).split("\n").length;
        problems.push(`${file.replace(ROOT, "")}:${line} ${match[1]}: ${columns} colunas, ${count} valores`);
      }
    }
  }
  assert.ok(checked > 100, `esperava varrer os INSERTs do projeto, achei ${checked}`);
  assert.deepEqual(problems, []);
});

test("benefício MANUAL de novato (contratado pelo Recrutamento, sem loja de admissão) é salvo", async () => {
  const db = await setupRouteDb(["shared_state", "hr_employees", "hr_benefits", "hr_benefit_items", "hr_payroll_settings"]);
  db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "clojaalfa1", name: "LOJA ALFA" }]) });
  db.insert("hr_employees", {
    id: "novato", full_name: "HERCULES", admission_date: "2026-11-02", company_id: "clojaalfa1", company_name: "LOJA ALFA",
    role_title: "VENDEDOR", status: "active", created_by: "x",
  });
  const benefits = await import("../app/api/hr-payroll/benefits/route.ts");
  const response = await callRoute(benefits.POST, { id: "admin", role: "admin" }, "POST", "/api/hr-payroll/benefits", {
    employeeId: "novato", month: "2026-11", paymentMethod: "pix",
    items: [{ type: "alimentacao", amountMode: "fixed", amountCents: 11111 }, { type: "mobilidade", amountMode: "fixed", amountCents: 5400 }],
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const row = db.sqlite.prepare("SELECT amount_cents, type, origin, created_by, updated_by FROM hr_benefits WHERE employee_id='novato'").get();
  assert.deepEqual({ ...row }, { amount_cents: 16511, type: "multiplo", origin: "manual", created_by: "admin", updated_by: "admin" });
});
