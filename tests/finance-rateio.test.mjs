import assert from "node:assert/strict";
import test from "node:test";

const { distributeAmount } = await import("../app/lib/rateio-distribute.ts");
const { RATEIO_MODELS } = await import("../app/lib/rateio-models.ts");

// Item 10 — modelos de rateio por base de faturamento (vendas / serviços / total).
test("os modelos de rateio por faturamento cobrem total, vendas e serviços", () => {
  assert.ok(RATEIO_MODELS.includes("faturamento"));
  assert.ok(RATEIO_MODELS.includes("faturamento_vendas"));
  assert.ok(RATEIO_MODELS.includes("faturamento_servicos"));
});

// Item 9 — a divisão é proporcional e a soma das fatias bate exatamente com
// o total (o resto do arredondamento vai para a última fatia).
test("distributeAmount: fatias proporcionais e soma exata", () => {
  const shares = distributeAmount(100000, [
    { companyId: "a", companyName: "A", percentBasisPoints: 3333 },
    { companyId: "b", companyName: "B", percentBasisPoints: 3333 },
    { companyId: "c", companyName: "C", percentBasisPoints: 3334 },
  ]);
  assert.equal(shares.reduce((s, x) => s + x.amountCents, 0), 100000);
  assert.equal(shares[0].amountCents, 33330);
  assert.equal(shares[1].amountCents, 33330);
  assert.equal(shares[2].amountCents, 33340);
});

test("distributeAmount: percentuais derivados do faturamento do mês somam 100%", () => {
  // Simula o que a branch 'faturamento' faz: % = faturamento_loja / total.
  const revenue = [
    { companyId: "a", amountCents: 700000 },
    { companyId: "b", amountCents: 300000 },
  ];
  const total = revenue.reduce((s, r) => s + r.amountCents, 0);
  const shares = revenue.map((r) => ({
    companyId: r.companyId,
    companyName: r.companyId,
    percentBasisPoints: Math.round((r.amountCents * 10000) / total),
  }));
  assert.deepEqual(
    shares.map((s) => s.percentBasisPoints),
    [7000, 3000],
  );
  const split = distributeAmount(50000, shares);
  assert.equal(split[0].amountCents, 35000);
  assert.equal(split[1].amountCents, 15000);
});
