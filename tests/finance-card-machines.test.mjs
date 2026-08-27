import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Financeiro Fase 7 — Maquinetas. Mesma limitação dos outros testes de
// Financeiro: as rotas fazem SQL cru e só rodam no runtime do Worker, então
// aqui ficam a lógica pura (app/lib/card-machines.ts) e as verificações de
// registro do módulo no HTML renderizado / worker / schema / migration.

const machines = await import("../app/lib/card-machines.ts");

test("evento de transferência move a maquineta e exige loja de destino diferente", () => {
  const current = { companyId: "cloja1x", companyName: "LOJA 1", status: "active" };
  const ok = machines.applyMachineEvent(current, {
    kind: "transfer",
    toCompanyId: "cloja2x",
    toCompanyName: "LOJA 2",
  });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.state, { companyId: "cloja2x", companyName: "LOJA 2", status: "active" });

  const semDestino = machines.applyMachineEvent(current, { kind: "transfer" });
  assert.match(semDestino.error ?? "", /LOJA DE DESTINO/);

  const mesmaLoja = machines.applyMachineEvent(current, { kind: "transfer", toCompanyId: "cloja1x" });
  assert.match(mesmaLoja.error ?? "", /MESMA LOJA/);
});

test("cancelamento seta status canceled; manutenção/substituição não mudam nada", () => {
  const current = { companyId: "cloja1x", companyName: "LOJA 1", status: "active" };
  assert.equal(machines.applyMachineEvent(current, { kind: "cancellation" }).state.status, "canceled");
  assert.deepEqual(machines.applyMachineEvent(current, { kind: "maintenance" }).state, current);
  assert.deepEqual(machines.applyMachineEvent(current, { kind: "replacement" }).state, current);
});

test("normalização de serial e validação do cadastro", () => {
  assert.equal(machines.normalizeSerial("  ab-12  "), "AB-12");
  assert.equal(machines.validateMachineDraft({ acquirerId: "", companyId: "c1", installedAt: "" }), "SELECIONE A ADQUIRENTE.");
  assert.equal(machines.validateMachineDraft({ acquirerId: "a1", companyId: "", installedAt: "" }), "SELECIONE A UNIDADE.");
  assert.match(
    machines.validateMachineDraft({ acquirerId: "a1", companyId: "c1", installedAt: "31/01/2026" }) ?? "",
    /DATA DE INSTALAÇÃO/,
  );
  assert.equal(machines.validateMachineDraft({ acquirerId: "a1", companyId: "c1", installedAt: "2026-01-31" }), null);
});

test("guardas de tipo de status/evento", () => {
  assert.equal(machines.isMachineStatus("transferred"), true);
  assert.equal(machines.isMachineStatus("foo"), false);
  assert.equal(machines.isMachineEventKind("replacement"), true);
  assert.equal(machines.isMachineEventKind(""), false);
});

test("Financeiro Fase 7: módulo Maquinetas registrado no HTML, worker, schema e migration", async () => {
  const [html, workerSource, schema, migration] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0039_finance_card_machines.sql", import.meta.url), "utf8"),
  ]);

  // Nav + rota nova dentro do submenu Financeiro, mesma permissão do módulo.
  assert.match(
    html,
    /id="navFinanceiroMaquinetas" data-page="financeiroMaquinetas" data-permission="finance"[^>]*href="\/financeiro\/maquinetas"/,
  );
  assert.match(html, /id="pageFinanceiroMaquinetas" class="page wrap"/);
  assert.match(html, /financeiroMaquinetas:'\/financeiro\/maquinetas'/);
  assert.match(html, /financeiroMaquinetas:'finance'/);
  assert.match(workerSource, /"\/financeiro\/maquinetas"/);

  // Dispatch on-enter nos dois caminhos (clique no menu e URL direta).
  assert.equal(html.split("if(name === 'financeiroMaquinetas') loadMaquinetasPage();").length - 1, 2);

  // Segurança: nenhum campo de senha/CVV entra no cadastro de maquineta
  // (a regra vale para todo o Financeiro Fase 7, mas checamos já aqui).
  assert.doesNotMatch(html, /machineForm[\s\S]{0,1500}?(cvv|cvc|senha do cart)/i);

  // Schema/migration com as três tabelas do módulo.
  assert.match(schema, /export const financeAcquirers = pgTable\(\s*"finance_acquirers"/);
  assert.match(schema, /export const financeCardMachines = pgTable\(\s*"finance_card_machines"/);
  assert.match(schema, /export const financeCardMachineEvents = pgTable\(\s*"finance_card_machine_events"/);
  assert.match(migration, /CREATE TABLE "finance_acquirers"/);
  assert.match(migration, /CREATE TABLE "finance_card_machines"/);
  assert.match(migration, /CREATE TABLE "finance_card_machine_events"/);
});
