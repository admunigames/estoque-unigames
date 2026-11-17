import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Controle de Reposição — IMPORTAR PDF (EXTRATO) (17/11/2026): extrato da
// conta do responsável no modelo do Banco Inter. Dados fictícios.

const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
const grab = (marker) => {
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, marker);
  let depth = 0, end = html.indexOf("{", start);
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    if (html[end] === "}" && --depth === 0) break;
  }
  return html.slice(start, end + 1);
};
const parse = new Function(`${grab("const RP_PDF_MONTHS =")};\n${grab("function rpParseGenericStatement(")};\n${grab("function rpParseStatementPdf(")}; return rpParseStatementPdf;`)();

const lines = [
  "Solicitado em: 16/11/2026 - 16h59",
  "FULANA DE TAL",
  "CPF/CNPJ: 000.000.000 - 00 , Instituição: Banco Inter , Agência: 0001 - 9 , Conta: 1 - 2",
  "Período: 16/10/2026 a 16/11/2026",
  "R$ 105,70 R$ 105,70 R$ 0,00",
  "16 de Outubro de 2026 Saldo do dia: R$ 556,19 Valor Saldo por transação",
  'Pix enviado: "Cp :60746948 - Loja Exemplo LTDA" - R$ 205,50 R$ 556,19',
  "21 de Outubro de 2026 Saldo do dia: R$ 454,25",
  'Pix enviado: "Cp :10573521 - 61147268 Fulano da Silva" - R$ 1.350,00 - R$ 33,81',
  'Pix recebido: "Cp :16501555 - BELTRANA SOUZA" R$ 1.000,00 R$ 454,25',
  "Fale com a gente",
  "SAC: 0800 940 9999 (opção 09)",
  "3 de Março de 2026 Saldo do dia: R$ 1,00",
  'Pix enviado: "Cp :16501555 - CHINA EMBALAGENS" (COMPRA DE SACOS - R$ 27,00 R$ 105,70',
  "DE LIXO)",
  'Pix recebido: "Cp :16501555 - BELTRANA SOUZA" (REPOSIÇÃO) R$ 1.000,00 R$ 951,70',
];

test("extrato em PDF: titular, data do dia, saída × reposição, motivo pela anotação ou favorecido", () => {
  const { holder, rows } = parse(lines);
  assert.equal(holder, "FULANA DE TAL");
  assert.deepEqual(
    rows.map((row) => [row.entryDate, row.kind, row.amountCents, row.reason, row.notes]),
    [
      ["2026-10-16", "saida", 20_550, "PIX ENVIADO — LOJA EXEMPLO LTDA", "PIX ENVIADO — LOJA EXEMPLO LTDA"],
      ["2026-10-21", "saida", 135_000, "PIX ENVIADO — FULANO DA SILVA", "PIX ENVIADO — FULANO DA SILVA"],
      ["2026-10-21", "reposicao", 100_000, "PIX RECEBIDO — BELTRANA SOUZA", "PIX RECEBIDO — BELTRANA SOUZA"],
      ["2026-03-03", "saida", 2_700, "COMPRA DE SACOS DE LIXO", "PIX ENVIADO — CHINA EMBALAGENS"],
      ["2026-03-03", "reposicao", 100_000, "REPOSIÇÃO", "PIX RECEBIDO — BELTRANA SOUZA"],
    ],
  );
});

test("outros bancos: leitura genérica por data + valor (sinal, D/C, seção, palavras)", () => {
  const rows = (lines) => parse(lines).rows.map((row) => [row.entryDate, row.kind, row.amountCents, row.reason]);
  // BB / Caixa: DD/MM/AAAA, documento, valor com D/C e saldo.
  assert.deepEqual(rows([
    "Nome: FULANA DE TAL Agência: 1234-5",
    "Período: 01/10/2026 a 31/10/2026",
    "01/10/2026 Saldo Anterior 500,00 C",
    "02/10/2026 000123 PIX - ENVIADO LOJA EXEMPLO 150,00 D 350,00 C",
    "03/10/2026 PIX - RECEBIDO BELTRANA 1.000,00 C 1.350,00 C",
    "04/10/2026 S A L D O 1.350,00 C",
  ]), [
    ["2026-10-02", "saida", 15_000, "PIX - ENVIADO LOJA EXEMPLO"],
    ["2026-10-03", "reposicao", 100_000, "PIX - RECEBIDO BELTRANA"],
  ]);
  assert.equal(parse(["Nome: FULANA DE TAL Agência: 1", "01/10/2026 PIX X 1,00 D"]).holder, "FULANA DE TAL");
  // Itaú: DD/MM sem ano (ano do período) e "-" depois do valor.
  assert.deepEqual(rows([
    "período de 01/10/2026 a 31/10/2026",
    "05/10 PIX TRANSF FULANO05/10 89,90-",
    "06/10 TED 237.0001 BELTRANA 300,00",
  ]), [
    ["2026-10-05", "saida", 8_990, "PIX TRANSF FULANO05/10"],
    ["2026-10-06", "saida", 30_000, "TED 237.0001 BELTRANA"],
  ]);
  // Nubank: "07 OUT 2026", seções Total de entradas/saídas, valor sem sinal.
  assert.deepEqual(rows([
    "07 OUT 2026 Total de entradas + 1.000,00",
    "Transferência recebida pelo Pix BELTRANA 1.000,00",
    "Total de saídas - 45,00",
    "Transferência enviada pelo Pix PADARIA 45,00",
  ]), [
    ["2026-10-07", "reposicao", 100_000, "TRANSFERÊNCIA RECEBIDA PELO PIX BELTRANA"],
    ["2026-10-07", "saida", 4_500, "TRANSFERÊNCIA ENVIADA PELO PIX PADARIA"],
  ]);
  // Mercado Pago / PagBank: DD-MM-AAAA e "R$ -"; descrição na linha de cima.
  assert.deepEqual(rows([
    "08-10-2026 Pagamento com QR Pix MERCADINHO 123456789 R$ -12,50 R$ 987,50",
    "Depósito em conta",
    "09-10-2026 R$ 200,00 R$ 1.187,50",
  ]), [
    ["2026-10-08", "saida", 1_250, "PAGAMENTO COM QR PIX MERCADINHO"],
    ["2026-10-09", "reposicao", 20_000, "DEPÓSITO EM CONTA"],
  ]);
});

test("tela: botão IMPORTAR PDF (EXTRATO), setor para todas as linhas e notas vão no lote", () => {
  assert.match(html, /id="btnReposicaoPdf"/);
  assert.match(html, /id="reposicaoBatchSector"/);
  assert.match(html, /sector: el\('reposicaoBatchSector'\)\.value, notes: tr\.dataset\.notes \|\| ''/);
});
