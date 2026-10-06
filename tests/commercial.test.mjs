import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_COMMERCIAL_RULES,
  aliasKey,
  computeSellerMetrics,
  isSellerRole,
  matchEmployee,
  monthClock,
  nameMatches,
  nextTarget,
  parseCommercialRules,
  parseSellerSheet,
  parseSheetNumber,
  progressPercent,
  progressTier,
  resolveCommercialRules,
  revenueTargets,
  storeMatches,
  suggestSheetName,
} = await import("../app/lib/commercial.ts");

const clock = monthClock("2026-09", "2026-09-21");
const goal = {
  targetRevenueCents: 10_000_000,
  targetItems: 100,
  targetSuperItems: 117,
  targetWarrantyCents: 500_000,
  targetRealme: 10,
};
function realized(values = {}) {
  return { revenueCents: 0, items: 0, warrantyCents: 0, realme: 0, warrantyQty: 0, notebookQty: 0, creditSalesCents: 0, ...values };
}

// Mesma estrutura da aba "VENDEDORES SETEMBRO" da planilha real (dados fictícios).
const HEADER = [
  "LOJAS", "VENDEDOR", "META REALMES", "REALMES FEITO", "META ITENS", "SUPER ITENS", "ITENS FEITO",
  "META G.A.R", "GAR FEITO", "VALOR GAR", "QT - Vendas", "QT G.A.R", "NOTEBOOK/PC", "PERCENTUAL",
  "FATURADO", "META", "PERCENTUAL", "ZONA",
];
const SHEET = [
  ["", "", " "],
  HEADER,
  ["LOJA ALFA", "JOAO", 13, 19, 290, 340, 379, 4000, 3898, 0, 220, 4, 11, 0.36, 192382.23, 170000, 1.13, "SUL"],
  ["", "MARIA C.", 13, 21, 290, 340, 338, 4000, 7638, 0, 181, 9, 28, 0.32, 254831.81, 170000, 1.49, "SUL"],
  ["LOJA BETA", "PEDRO", 14, 9, 310, 350, 273, 2000, 0, 0, 162, 0, 5, 0, "98.711,40", "R$ 140.000,00", 0.7, "NORTE"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["", "TOTAL", 40, 49, 890, 1030, 990, 10000, 11536, 0, 563, 13, 44, 0, 545925.44, 480000, 1.1, ""],
];

test("isSellerRole: comparação normalizada do CARGO (texto livre)", () => {
  assert.equal(isSellerRole("Vendedor"), true);
  assert.equal(isSellerRole("VENDEDOR(A)"), true);
  assert.equal(isSellerRole("vendedora"), true);
  assert.equal(isSellerRole(" Vendédora "), true);
  assert.equal(isSellerRole("Gerente"), false);
});

test("parseSheetNumber: número do Excel ou texto no formato brasileiro", () => {
  assert.equal(parseSheetNumber(192382.23), 192382.23);
  assert.equal(parseSheetNumber("98.711,40"), 98711.4);
  assert.equal(parseSheetNumber("R$ 140.000,00"), 140000);
  assert.equal(parseSheetNumber("12,5"), 12.5);
  assert.equal(parseSheetNumber(""), 0);
  assert.equal(parseSheetNumber(null), 0);
  assert.equal(parseSheetNumber("abc"), null);
});

test("parseSellerSheet: lê a aba VENDEDORES com loja mesclada, ignora TOTAL e linhas vazias", () => {
  const { rows, errors } = parseSellerSheet(SHEET);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 3);
  const [joao, maria, pedro] = rows;
  assert.deepEqual(joao, {
    rowNumber: 3, storeLabel: "LOJA ALFA", sellerLabel: "JOAO", zone: "SUL",
    targetRevenueCents: 17_000_000, targetItems: 290, targetSuperItems: 340, targetWarrantyCents: 400_000,
    targetRealme: 13, revenueCents: 19_238_223, items: 379, warrantyCents: 389_800, realme: 19,
    warrantyQty: 4, notebookQty: 11, creditSalesCents: 0,
  });
  assert.equal(maria.storeLabel, "LOJA ALFA"); // herdada da célula mesclada
  assert.equal(pedro.storeLabel, "LOJA BETA");
  assert.equal(pedro.revenueCents, 9_871_140);
  assert.equal(pedro.targetRevenueCents, 14_000_000);
  assert.equal(pedro.zone, "NORTE");
});

test("parseSellerSheet: aponta cabeçalho ausente, coluna obrigatória faltando e valor inválido", () => {
  assert.match(parseSellerSheet([["A", "B"], [1, 2]]).errors[0], /CABEÇALHO/);
  assert.match(parseSellerSheet([["LOJAS", "VENDEDOR", "FATURADO"], ["X", "Y", 1]]).errors[0], /FALTAM AS COLUNAS: META/);
  const bad = parseSellerSheet([HEADER, ["X", "ANA", 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, "muito", 100, 0, "SUL"]]);
  assert.equal(bad.rows.length, 0);
  assert.match(bad.errors[0], /LINHA 2 \(ANA\)/);
});

test("suggestSheetName: escolhe a aba VENDEDORES do mês (inclusive com erro de digitação)", () => {
  const names = ["LOJAS SETEMBRO", "VENDEDORES SETEMBRO 2025", "VENDEDORES SETEMBRO", "VENDEDORS AGOSTO.", "SITE SETEMBRO"];
  assert.equal(suggestSheetName(names, "2026-09"), "VENDEDORES SETEMBRO");
  assert.equal(suggestSheetName(names, "2025-09"), "VENDEDORES SETEMBRO 2025");
  assert.equal(suggestSheetName(names, "2026-08"), "VENDEDORS AGOSTO.");
  assert.equal(suggestSheetName(names, "2026-10"), "");
});

test("reconhecimento do vendedor: apelido x nome completo e loja", () => {
  assert.equal(nameMatches("OTAVIO", "Otávio Souza Lima"), true);
  assert.equal(nameMatches("VITOR V.", "Vitor Vasconcelos"), true);
  assert.equal(nameMatches("VITOR V.", "Vitor Almeida"), false);
  assert.equal(nameMatches("TATIANY LUIZA", "Tatiany Luiza Ramos"), true);
  assert.equal(nameMatches("JOÃO VITOR", "João Pedro Vitor"), true);
  assert.equal(nameMatches("ANA", "Mariana Costa"), false);
  assert.equal(storeMatches("RIO MAR", "RIOMAR"), true);
  assert.equal(storeMatches("GUARARAPES", "GUARA"), true);
  assert.equal(storeMatches("QUIOSQUE", "P.A QUIOSQUE"), true);
  assert.equal(storeMatches("PATTEO", "RECIFE"), false);
});

test("matchEmployee: vínculo salvo > nome+loja > nome; ambíguo não casa", () => {
  const employees = [
    { id: "e1", fullName: "João Silva", companyName: "LOJA ALFA", isSeller: true },
    { id: "e2", fullName: "João Souza", companyName: "LOJA BETA", isSeller: true },
    { id: "e3", fullName: "Pedro Lima", companyName: "LOJA BETA", isSeller: true },
    { id: "e4", fullName: "Pedro Alves", companyName: "LOJA BETA", isSeller: false },
    { id: "e5", fullName: "Carla Dias", companyName: "LOJA ALFA", isSeller: true },
    { id: "e6", fullName: "Carla Nunes", companyName: "LOJA ALFA", isSeller: true },
  ];
  const none = new Map();
  assert.deepEqual(matchEmployee({ storeLabel: "LOJA ALFA", sellerLabel: "JOAO" }, employees, none), { employeeId: "e1", by: "name" });
  // Dois Pedros na loja, só um é vendedor → o vendedor.
  assert.deepEqual(matchEmployee({ storeLabel: "LOJA BETA", sellerLabel: "PEDRO" }, employees, none), { employeeId: "e3", by: "name" });
  // Duas Carlas vendedoras na mesma loja → ambíguo.
  assert.equal(matchEmployee({ storeLabel: "LOJA ALFA", sellerLabel: "CARLA" }, employees, none), null);
  // Vínculo salvo resolve a ambiguidade.
  const saved = new Map([[aliasKey("LOJA ALFA", "CARLA"), "e6"]]);
  assert.deepEqual(matchEmployee({ storeLabel: "loja alfa", sellerLabel: "Carla" }, employees, saved), { employeeId: "e6", by: "alias" });
  // Ninguém com esse nome.
  assert.equal(matchEmployee({ storeLabel: "LOJA ALFA", sellerLabel: "ZECA" }, employees, none), null);
});

test("progressPercent/progressTier: vermelho < 80 ≤ amarelo < 100 ≤ verde", () => {
  assert.equal(progressPercent(0, 0), null);
  assert.equal(progressTier(null), "none");
  assert.equal(progressPercent(79_99, 100_00), 79.9);
  assert.equal(progressTier(79.9), "red");
  assert.equal(progressTier(80), "yellow");
  assert.equal(progressTier(100), "green");
});

// Vendedor que bate os 3 critérios: itens 100/100, realme 10/10, anexo 3 de 10 = 30%.
const allMet = { items: 100, realme: 10, warrantyQty: 3, notebookQty: 10 };

test("critérios: Itens 100%, Realme 100% e anexo de garantia ≥ 30% (em quantidade, sem arredondar)", () => {
  const at = (values) => computeSellerMetrics(goal, realized({ ...allMet, ...values }), clock);
  assert.equal(at({}).commission.allCriteriaMet, true);
  assert.equal(at({ items: 99 }).commission.allCriteriaMet, false);
  assert.equal(at({ realme: 9 }).commission.allCriteriaMet, false);
  assert.equal(at({ warrantyQty: 2 }).commission.allCriteriaMet, false); // 2 de 10 = 20%
  const tres = at({ warrantyQty: 1, notebookQty: 3 }); // 1 de 3 = 33,3%
  assert.equal(tres.warranty.met, true);
  assert.equal(tres.warranty.attachPercent, 33.3);
  const quase = at({ warrantyQty: 2, notebookQty: 7 }); // 28,5% → precisa de 3
  assert.equal(quase.warranty.met, false);
  assert.equal(quase.warranty.missingQty, 1);
  assert.equal(quase.warranty.tier, "yellow");
});

test("casos de borda: meta de Itens/Realme zerada conta como batida; sem notebook/PC o anexo NÃO bate", () => {
  const semMetas = { ...goal, targetItems: 0, targetRealme: 0 };
  assert.equal(computeSellerMetrics(semMetas, realized({ warrantyQty: 3, notebookQty: 10 }), clock).commission.allCriteriaMet, true);
  const semNotebook = computeSellerMetrics(goal, realized({ ...allMet, warrantyQty: 0, notebookQty: 0 }), clock);
  assert.equal(semNotebook.warranty.attachPercent, null);
  assert.equal(semNotebook.warranty.met, false);
  assert.equal(semNotebook.warranty.tier, "none");
  assert.equal(semNotebook.commission.allCriteriaMet, false);
});

test("faturamento: 0,6% com todos os critérios, 0,4% sem (sempre, sem mínimo de meta)", () => {
  const ok = computeSellerMetrics(goal, realized({ ...allMet, revenueCents: 5_000_000 }), clock).commission;
  assert.equal(ok.revenueRateBps, 60);
  assert.equal(ok.revenueCommissionCents, 30_000); // 0,6% de R$ 50.000 (só 50% da meta)
  const nao = computeSellerMetrics(goal, realized({ ...allMet, items: 50, revenueCents: 5_000_000 }), clock).commission;
  assert.equal(nao.revenueRateBps, 40);
  assert.equal(nao.revenueCommissionCents, 20_000); // 0,4% mesmo abaixo de 80% da meta
});

test("premiação sobre a META DE FATURAMENTO, não cumulativa, e só com todos os critérios", () => {
  const prize = (revenueCents, extra = {}) =>
    computeSellerMetrics(goal, realized({ ...allMet, revenueCents, ...extra }), clock).commission.revenuePremiumCents;
  assert.equal(prize(10_999_999), 0);
  assert.equal(prize(11_000_000), 50_000);
  assert.equal(prize(11_999_999), 50_000);
  assert.equal(prize(12_000_000), 150_000);
  assert.equal(prize(20_000_000), 150_000);
  assert.equal(prize(12_000_000, { realme: 0 }), 0); // não bateu Realme → sem premiação
  // Itens acima da meta não geram premiação por si só (regra antiga removida).
  assert.equal(prize(10_000_000, { items: 130 }), 0);
});

test("garantia 4% fixo sobre o valor, mesmo sem bater critérios; SUPER ITENS só referência", () => {
  const nada = computeSellerMetrics(goal, realized({ warrantyCents: 389_800 }), clock);
  assert.equal(nada.commission.allCriteriaMet, false);
  assert.equal(nada.commission.warrantyCommissionCents, 15_592);
  const itens = computeSellerMetrics(goal, realized({ items: 117 }), clock);
  assert.equal(itens.items.superReached, true);
  assert.equal(itens.items.superTarget, 117);
});

test("total estimado = faturamento + premiação + garantia", () => {
  const m = computeSellerMetrics(goal, realized({ ...allMet, revenueCents: 12_000_000, warrantyCents: 200_000 }), clock);
  assert.equal(m.commission.totalCents, 72_000 + 150_000 + 8_000);
  const semCriterio = computeSellerMetrics(goal, realized({ revenueCents: 12_000_000, warrantyCents: 200_000 }), clock);
  assert.equal(semCriterio.commission.totalCents, 48_000 + 0 + 8_000);
});

test("monthClock e nextTarget: dias restantes contam hoje; média diária = falta ÷ dias", () => {
  assert.equal(clock.daysRemaining, 10);
  assert.equal(monthClock("2026-08", "2026-09-21").daysRemaining, 0);
  assert.equal(monthClock("2026-10", "2026-09-21").daysRemaining, 31);
  assert.deepEqual(nextTarget(7_400_000, 10_000_000, [80, 100, 110, 120], clock), {
    index: 1, percent: 80, value: 8_000_000, missing: 600_000, perDay: 60_000,
  });
  assert.equal(nextTarget(12_000_000, 10_000_000, [80, 100, 110, 120], clock), null);
  assert.equal(nextTarget(0, 10_000_000, [80], monthClock("2026-08", "2026-09-21")).perDay, null);
});

// ---------------------------------------------------------------------------
// Regras por vigência, crediário e novato (pedido de 2026-10-06)
// ---------------------------------------------------------------------------

// Mesma regra que a migration 0085 cadastra para 2026-10.
const OCTOBER = {
  ...DEFAULT_COMMERCIAL_RULES,
  validFrom: "2026-10",
  warrantyRateBps: 600,
  creditRateBps: 200,
};

test("regra vigente: setembro (sem vigência) usa a padrão com garantia 4%; outubro em diante usa a de 2026-10", () => {
  const saved = [OCTOBER, { ...OCTOBER, validFrom: "2027-03", creditRateBps: 300 }];
  assert.equal(resolveCommercialRules(saved, "2026-09"), DEFAULT_COMMERCIAL_RULES);
  assert.equal(resolveCommercialRules(saved, "2026-09").warrantyRateBps, 400);
  assert.equal(resolveCommercialRules(saved, "2026-09").creditRateBps, 0);
  assert.equal(resolveCommercialRules(saved, "2026-10").warrantyRateBps, 600);
  assert.equal(resolveCommercialRules(saved, "2027-02").validFrom, "2026-10");
  assert.equal(resolveCommercialRules(saved, "2027-03").creditRateBps, 300);
  assert.equal(resolveCommercialRules([], "2030-01"), DEFAULT_COMMERCIAL_RULES);

  const sept = computeSellerMetrics(goal, realized({ warrantyCents: 100_000 }), clock, resolveCommercialRules(saved, "2026-09"));
  const oct = computeSellerMetrics(goal, realized({ warrantyCents: 100_000 }), clock, resolveCommercialRules(saved, "2026-10"));
  assert.equal(sept.commission.warrantyCommissionCents, 4_000);
  assert.equal(oct.commission.warrantyCommissionCents, 6_000);
});

test("crediário: paga só a própria % (2%) e sai da base do faturamento", () => {
  const m = computeSellerMetrics(goal, realized({ ...allMet, revenueCents: 10_000_000, creditSalesCents: 2_000_000 }), clock, OCTOBER);
  assert.equal(m.commission.revenueBaseCents, 8_000_000);
  assert.equal(m.commission.revenueCommissionCents, 48_000); // 0,6% de R$ 80.000
  assert.equal(m.commission.creditCommissionCents, 40_000); // 2% de R$ 20.000
  assert.equal(m.commission.totalCents, 48_000 + 0 + 0 + 40_000);
  // Crediário maior que o faturado: base nunca negativa.
  const over = computeSellerMetrics(goal, realized({ revenueCents: 100, creditSalesCents: 500 }), clock, OCTOBER);
  assert.equal(over.commission.revenueBaseCents, 0);
  assert.equal(over.commission.revenueCommissionCents, 0);
  // Regra padrão (setembro) não paga crediário: o faturado inteiro continua
  // na base (setembro não muda nem reimportando com a coluna nova).
  const sept = computeSellerMetrics(goal, realized({ revenueCents: 10_000_000, creditSalesCents: 2_000_000 }), clock);
  assert.equal(sept.commission.creditCommissionCents, 0);
  assert.equal(sept.commission.revenueBaseCents, 10_000_000);
  assert.equal(sept.commission.revenueCommissionCents, 40_000); // 0,4% de R$ 100.000
});

test("premiação: maior faixa atingida pelo FATURADO TOTAL (com o crediário), só com os 3 critérios", () => {
  const prize = (values, rules = OCTOBER) =>
    computeSellerMetrics(goal, realized({ ...allMet, ...values }), clock, rules).commission.revenuePremiumCents;
  // R$ 120.000 faturados, metade em crediário: continua 120% da meta.
  assert.equal(prize({ revenueCents: 12_000_000, creditSalesCents: 6_000_000 }), 150_000);
  assert.equal(prize({ revenueCents: 11_500_000 }), 50_000);
  assert.equal(prize({ revenueCents: 12_000_000, items: 10 }), 0);

  const three = {
    ...OCTOBER,
    premiumTiers: [{ percent: 100, cents: 20_000 }, { percent: 115, cents: 80_000 }, { percent: 130, cents: 200_000 }],
  };
  assert.equal(prize({ revenueCents: 9_999_999 }, three), 0);
  assert.equal(prize({ revenueCents: 10_000_000 }, three), 20_000);
  assert.equal(prize({ revenueCents: 12_900_000 }, three), 80_000);
  assert.equal(prize({ revenueCents: 13_000_000 }, three), 200_000); // não cumulativa
  // Marcos da barra: a meta + as faixas (100% não duplica).
  assert.deepEqual(revenueTargets(three), [100, 115, 130]);
  assert.deepEqual(revenueTargets(DEFAULT_COMMERCIAL_RULES), [100, 110, 120]);
  assert.deepEqual(revenueTargets({ ...OCTOBER, premiumTiers: [] }), [100]);
  const m = computeSellerMetrics(goal, realized({ revenueCents: 12_000_000 }), clock, three);
  assert.equal(m.revenue.reachedTargets, 2);
  assert.equal(m.revenue.next.percent, 130);
});

test("anexo mínimo de garantia vem da regra", () => {
  const forty = { ...OCTOBER, warrantyAttachTarget: 40 };
  const m = computeSellerMetrics(goal, realized({ ...allMet }), clock, forty); // 3 de 10 = 30%
  assert.equal(m.warranty.met, false);
  assert.equal(m.warranty.missingQty, 1);
  assert.equal(m.warranty.attachTarget, 40);
  assert.equal(m.commission.allCriteriaMet, false);
});

test("novato: só a % do faturamento — sem premiação, garantia e crediário", () => {
  const values = realized({ ...allMet, revenueCents: 12_000_000, warrantyCents: 200_000, creditSalesCents: 1_000_000 });
  const normal = computeSellerMetrics(goal, values, clock, OCTOBER, false).commission;
  const novato = computeSellerMetrics(goal, values, clock, OCTOBER, true).commission;
  assert.equal(normal.revenuePremiumCents, 150_000);
  assert.equal(normal.warrantyCommissionCents, 12_000);
  assert.equal(normal.creditCommissionCents, 20_000);
  assert.equal(novato.newcomer, true);
  assert.equal(novato.allCriteriaMet, true);
  assert.equal(novato.revenueRateBps, 60); // continua pelos critérios
  assert.equal(novato.revenueCommissionCents, normal.revenueCommissionCents); // 0,6% de R$ 110.000
  assert.equal(novato.revenueCommissionCents, 66_000);
  assert.equal(novato.revenuePremiumCents, 0);
  assert.equal(novato.warrantyCommissionCents, 0);
  assert.equal(novato.creditCommissionCents, 0);
  assert.equal(novato.totalCents, 66_000);
});

test("parseCommercialRules: valida percentuais, anexo e faixas crescentes", () => {
  const valid = {
    validFrom: "2026-11", revenueRateHighBps: 70, revenueRateLowBps: 40, warrantyRateBps: 600,
    warrantyAttachTarget: 30, creditRateBps: 200,
    premiumTiers: [{ percent: 110, cents: 50_000 }, { percent: 120, cents: 150_000 }, { percent: 140, cents: 300_000 }],
  };
  const ok = parseCommercialRules(valid);
  assert.equal(ok.error, "");
  assert.equal(ok.rules.premiumTiers.length, 3);
  assert.deepEqual(parseCommercialRules({ ...valid, premiumTiers: [] }).rules.premiumTiers, []);
  assert.match(parseCommercialRules({ ...valid, validFrom: "2026-13" }).error, /MÊS DE INÍCIO/);
  assert.match(parseCommercialRules({ ...valid, revenueRateHighBps: 10_001 }).error, /ENTRE 0% E 100%/);
  assert.match(parseCommercialRules({ ...valid, creditRateBps: -1 }).error, /CREDIÁRIO/);
  assert.match(parseCommercialRules({ ...valid, warrantyRateBps: 1.5 }).error, /GARANTIA/);
  assert.match(parseCommercialRules({ ...valid, warrantyAttachTarget: 101 }).error, /ANEXO/);
  assert.match(parseCommercialRules({ ...valid, premiumTiers: [{ percent: 120, cents: 1 }, { percent: 110, cents: 2 }] }).error, /CRESCENTES/);
  assert.match(parseCommercialRules({ ...valid, premiumTiers: [{ percent: 110, cents: 500 }, { percent: 120, cents: 500 }] }).error, /CRESCENTES/);
  assert.match(parseCommercialRules({ ...valid, premiumTiers: [{ percent: 90, cents: 500 }] }).error, /100% A 1000%/);
  assert.match(parseCommercialRules({ ...valid, premiumTiers: [{ percent: 110, cents: 0 }] }).error, /VALOR/);
  assert.match(parseCommercialRules({ ...valid, premiumTiers: "x" }).error, /FAIXAS/);
  const five = [1, 2, 3, 4, 5].map((n) => ({ percent: 100 + n * 10, cents: n * 10_000 }));
  assert.match(parseCommercialRules({ ...valid, premiumTiers: five }).error, /ATÉ 4 FAIXAS/);
});

test("parseSellerSheet: coluna CREDIÁRIO opcional (todos os nomes aceitos)", () => {
  // Sem a coluna: 0 (planilhas antigas).
  assert.equal(parseSellerSheet(SHEET).rows[0].creditSalesCents, 0);
  for (const label of ["CREDIÁRIO", "Crediário Feito", "VALOR CREDIÁRIO", "CREDIARIOS"]) {
    const { rows, errors } = parseSellerSheet([
      ["LOJAS", "VENDEDOR", "FATURADO", "META", label],
      ["LOJA ALFA", "JOAO", 100000, 90000, "12.345,67"],
      ["", "MARIA", 50000, 90000, ""],
    ]);
    assert.deepEqual(errors, [], label);
    assert.equal(rows[0].creditSalesCents, 1_234_567, label);
    assert.equal(rows[1].creditSalesCents, 0, label);
  }
  const bad = parseSellerSheet([["LOJAS", "VENDEDOR", "FATURADO", "META", "CREDIARIO"], ["X", "ANA", 1, 1, "abc"]]);
  assert.match(bad.errors[0], /LINHA 2 \(ANA\)/);
});
