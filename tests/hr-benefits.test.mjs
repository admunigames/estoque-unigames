import assert from "node:assert/strict";
import test from "node:test";

// Lógica pura dos lançamentos de Benefícios com múltiplos tipos + desconto.
// Não toca banco (mesma convenção das outras suítes finance-*).

const { parseBenefitItems, benefitTotalsFromItems, headerBenefitType } = await import(
  "../app/lib/hr-benefits.ts"
);

test("aceita vários tipos num lançamento e soma bruto/desconto/líquido", () => {
  const { items, error } = parseBenefitItems([
    { type: "alimentacao", amountCents: 30000, discountCents: 5000 },
    { type: "mobilidade", amountCents: 12000 },
  ]);
  assert.equal(error, "");
  assert.equal(items.length, 2);
  const totals = benefitTotalsFromItems(items);
  assert.deepEqual(totals, { grossCents: 42000, discountCents: 5000, netCents: 37000 });
  assert.equal(headerBenefitType(items), "multiplo");
});

test("tipo do cabeçalho é o próprio quando há uma linha só", () => {
  const { items } = parseBenefitItems([{ type: "premiacao", amountCents: 8000 }]);
  assert.equal(headerBenefitType(items), "premiacao");
});

test("compatibilidade: corpo antigo (sem items) monta uma linha única", () => {
  const { items, error } = parseBenefitItems(undefined, { type: "outros", amountCents: 5000 });
  assert.equal(error, "");
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "outros");
  assert.equal(items[0].amountCents, 5000);
  assert.equal(items[0].discountCents, 0);
  assert.equal(items[0].amountMode, "fixed");
});

test("rejeita desconto maior que o valor", () => {
  const { error } = parseBenefitItems([{ type: "alimentacao", amountCents: 1000, discountCents: 2000 }]);
  assert.match(error, /DESCONTO NÃO PODE SER MAIOR/);
});

test("rejeita tipo inválido, valor <= 0 e lista vazia", () => {
  assert.match(parseBenefitItems([{ type: "vale_gas", amountCents: 100 }]).error, /TIPO DE BENEFÍCIO VÁLIDO/);
  assert.match(parseBenefitItems([{ type: "outros", amountCents: 0 }]).error, /MAIOR QUE ZERO/);
  assert.match(parseBenefitItems([]).error, /AO MENOS UM BENEFÍCIO/);
});

test("rejeita desconto negativo", () => {
  assert.match(
    parseBenefitItems([{ type: "outros", amountCents: 1000, discountCents: -5 }]).error,
    /NÃO PODE SER NEGATIVO/,
  );
});
