import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Financeiro Fase 7 — Conciliação Bancária. Lógica pura (normalização do
// nome do estabelecimento, sugestão por regra aprendida, parsing de OFX) +
// registro do módulo.

const recon = await import("../app/lib/bank-reconciliation.ts");

test("normalizeMerchantKey remove sufixos que variam a cada transação", () => {
  assert.equal(recon.normalizeMerchantKey("NEOENERGIA PE *1234  05/08"), "neoenergia pe");
  assert.equal(recon.normalizeMerchantKey("Neoenergia Pernambuco"), "neoenergia pernambuco");
  assert.equal(recon.normalizeMerchantKey("PAG*IFOOD  12345678"), "pag ifood");
  assert.equal(recon.normalizeMerchantKey("AMAZON BR LTDA"), "amazon br");
});

test("suggestFromRules: match por chave, mais ocorrências ganha, sem histórico devolve null", () => {
  const rules = [
    { merchantKey: "neoenergia pe", categoryItemId: "item-energia", subcategory: "", costCenterId: "cc-adm", inDre: 1, inRateio: 1, hits: 3 },
    { merchantKey: "neoenergia pe", categoryItemId: "item-outros", subcategory: "", costCenterId: "", inDre: 1, inRateio: 0, hits: 1 },
    { merchantKey: "ifood", categoryItemId: "item-refeicao", subcategory: "", costCenterId: "", inDre: 1, inRateio: 0, hits: 5 },
  ];
  assert.equal(recon.suggestFromRules("neoenergia pe", rules)?.categoryItemId, "item-energia");
  assert.equal(recon.suggestFromRules("ifood", rules)?.categoryItemId, "item-refeicao");
  assert.equal(recon.suggestFromRules("posto shell", rules), null);
  assert.equal(recon.suggestFromRules("", rules), null);
});

test("parseOfxStatement: lê STMTTRN preservando o sinal do valor", () => {
  const ofx = `
    <OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
    <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260805120000<TRNAMT>-152.30<FITID>ABC123<NAME>NEOENERGIA PE</STMTTRN>
    <STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260806<TRNAMT>2000.00<FITID>ABC124<MEMO>DEP DINHEIRO</STMTTRN>
    </BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const txs = recon.parseOfxStatement(ofx);
  assert.equal(txs.length, 2);
  assert.deepEqual(txs[0], { fitId: "ABC123", date: "2026-08-05", amountCents: -15230, description: "NEOENERGIA PE" });
  assert.equal(txs[1].amountCents, 200000);
  assert.equal(txs[1].description, "DEP DINHEIRO");
});

test("Financeiro Fase 7: Conciliação Bancária registrada + aprendizado por nome", async () => {
  const [html, workerSource, schema, migration, listRoute, patchRoute] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0042_finance_bank_reconciliation.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/bank-reconciliation/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/bank-reconciliation/[id]/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    html,
    /id="navFinanceiroConciliacao" data-page="financeiroConciliacao" data-permission="finance"[^>]*href="\/financeiro\/conciliacao-bancaria"/,
  );
  assert.match(html, /id="pageFinanceiroConciliacao" class="page wrap"/);
  assert.match(html, /financeiroConciliacao:'\/financeiro\/conciliacao-bancaria'/);
  assert.match(workerSource, /"\/financeiro\/conciliacao-bancaria"/);
  assert.equal(html.split("if(name === 'financeiroConciliacao') loadConciliacaoPage();").length - 1, 2);

  // Fluxo de classificação: categoria, unidade, centro de custo, DRE e rateio.
  assert.match(html, /data-recon-field="categoryItemId"/);
  assert.match(html, /data-recon-field="inDre"/);
  assert.match(html, /data-recon-field="inRateio"/);
  // "Adicionar como Despesa" reaproveita /expenses.
  assert.match(html, /bankReconciliationId: entryId/);

  // Schema/migration: 3 tabelas + índice único da regra de aprendizado.
  assert.match(schema, /export const financeBankStatementEntries = pgTable/);
  assert.match(schema, /export const financeBankClassificationRules = pgTable/);
  assert.match(migration, /CREATE TABLE "finance_bank_statement_entries"/);
  assert.match(migration, /CREATE UNIQUE INDEX "finance_bank_classification_rules_key_idx"/);

  // Importação dedupe por fit_id; PATCH com confirm faz upsert da regra.
  assert.match(listRoute, /fit_id/);
  assert.match(listRoute, /suggestFromRules/);
  assert.match(patchRoute, /finance_bank_classification_rules/);
  assert.match(patchRoute, /hits/);
});
