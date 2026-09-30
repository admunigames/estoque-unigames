import assert from "node:assert/strict";
import test from "node:test";

const {
  aliasKey,
  computeSellerMetrics,
  isSellerRole,
  matchEmployee,
  monthClock,
  nameMatches,
  nextTarget,
  parseSellerSheet,
  parseSheetNumber,
  progressPercent,
  progressTier,
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
  return { revenueCents: 0, items: 0, warrantyCents: 0, realme: 0, warrantyQty: 0, notebookQty: 0, ...values };
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
    warrantyQty: 4, notebookQty: 11,
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

test("comissão de faturamento: 0 abaixo de 80%, 0,4% de 80% a 99,9%, 0,6% a partir de 100%", () => {
  const at = (revenueCents) => computeSellerMetrics(goal, realized({ revenueCents }), clock).commission;
  assert.equal(at(7_999_999).revenueCommissionCents, 0);
  assert.equal(at(8_000_000).revenueRate, 0.004);
  assert.equal(at(8_000_000).revenueCommissionCents, 32_000);
  assert.equal(at(9_999_999).revenueRate, 0.004);
  assert.equal(at(10_000_000).revenueCommissionCents, 60_000);
});

test("premiação por itens NÃO cumulativa (110% → R$ 500; 120% → R$ 1.500); SUPER ITENS só referência", () => {
  const at = (items) => computeSellerMetrics(goal, realized({ items }), clock);
  assert.equal(at(109).commission.itemsPremiumCents, 0);
  assert.equal(at(110).commission.itemsPremiumCents, 50_000);
  assert.equal(at(119).commission.itemsPremiumCents, 50_000);
  assert.equal(at(120).commission.itemsPremiumCents, 150_000);
  assert.equal(at(116).items.superReached, false);
  assert.equal(at(117).items.superReached, true);
  assert.equal(at(117).items.superTarget, 117);
});

test("garantia 4% fixo; Realmes sem comissão; anexo de garantia = QT G.A.R ÷ NOTEBOOK/PC", () => {
  const metrics = computeSellerMetrics(goal, realized({ warrantyCents: 389_800, realme: 19, warrantyQty: 4, notebookQty: 11 }), clock);
  assert.equal(metrics.commission.warrantyCommissionCents, 15_592);
  assert.equal(metrics.realme.percent, 190);
  assert.equal(metrics.realme.tier, "green");
  assert.equal(metrics.attachPercent, 36.3);
  assert.equal(metrics.commission.totalCents, 15_592);
  assert.equal(computeSellerMetrics(goal, realized(), clock).attachPercent, null);
});

test("total estimado soma as três regras", () => {
  const metrics = computeSellerMetrics(goal, realized({ revenueCents: 12_000_000, items: 121, warrantyCents: 200_000 }), clock);
  assert.equal(metrics.commission.totalCents, 72_000 + 150_000 + 8_000);
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
