// Auditoria Operacional (checklist de loja) — base do PDF "AUDITORIA
// OPERACIONAL" (Diretrizes Operacionais Unigames). Lógica pura, sem imports,
// para a rota e os testes usarem direto.

export const AOP_SECTIONS = ["ORGANIZACIONAL", "ADMINISTRATIVO", "TÉCNICO"] as const;
export const AOP_ANSWERS = ["feito", "nao_feito"] as const;
export type AopAnswer = (typeof AOP_ANSWERS)[number] | "";

const DEFAULT_GROUPS: [string, string, string[]][] = [
  ["ORGANIZACIONAL", "ORGANIZAÇÃO", [
    "Produtos estocados setorizados e organizados.",
    "Etiquetas atualizadas e corretamente aplicadas nos produtos estocados.",
    "Pente-fino geral na exposição dos itens.",
    "Revisão dos adesivos Unigames.",
    "Revisão da precificação dos produtos.",
    "Revisão dos produtos expostos no Relatório 41.",
    "Revisão das pendências da loja (luz queimada, notebook quebrado e demais equipamentos que precisem de correção).",
  ]],
  ["ORGANIZACIONAL", "LIMPEZA", [
    "Pés das cadeiras.",
    "Dutos de ar.",
    "Vitrines de exposição.",
    "Letreiros visíveis.",
    "Celulares abertos: verificar limpeza e etiqueta informativa.",
    "Produtos expostos abertos, com foco especial nos PCs Gamer.",
    "Área Kids.",
    "PC Gamer de exposição.",
    "Retaguarda: móvel de suporte, área embaixo da escada e demais pontos de apoio.",
    "Revisão da limpeza do micro-ondas e frigobar.",
    "Cafeteiras da loja e do mezanino.",
    "Sala do ar-condicionado.",
  ]],
  ["ADMINISTRATIVO", "", [
    "Check-in e check-out da abertura de loja.",
    "Conferência dos relatórios encaminhados por e-mail (últimos enviados para Renato).",
    "Impressão de certificados na quantidade necessária para a operação.",
    "Revisão da execução da troca de turno.",
    "Revisão dos insumos necessários para a loja.",
    "Revisão da conclusão da rotina operacional.",
    "Padronização dos notebooks da loja.",
  ]],
  ["TÉCNICO", "", [
    "Revisão dos insumos necessários para a assistência.",
    "Ordens de serviço testadas e respectivos clientes devidamente avisados.",
    "Conferência dos itens de uso da loja: controles, cabeamentos para teste, teclado e mouse.",
    "Verificação de pendências de respostas do setor da assistência técnica pelo WhatsApp.",
    "Organização e setorização dos itens da parte técnica (WD, limpa-contato, externo, pinças e demais materiais).",
    "Conferência dos produtos de venda que estão na assistência.",
  ]],
];

/** Os 32 itens iniciais (ids fixos: gravar duas vezes não duplica). */
export const AOP_DEFAULT_ITEMS = DEFAULT_GROUPS.flatMap(([section, groupName, texts]) => texts.map((text) => ({ section, groupName, text })))
  .map((item, index) => ({ id: `padrao-${String(index + 1).padStart(2, "0")}`, sortOrder: (index + 1) * 10, ...item }));

type AnswerRow = { section: string; groupName: string; text: string; answer: string; note: string };

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

/**
 * Nota (% FEITO sobre o total de itens) geral e por seção, e o resumo do que
 * precisa melhorar: só os NÃO FEITOS, agrupados por seção, com a observação.
 */
export function buildSummary(rows: AnswerRow[]) {
  const sections = [...new Set(rows.map((row) => row.section))].map((section) => {
    const inSection = rows.filter((row) => row.section === section);
    const done = inSection.filter((row) => row.answer === "feito").length;
    return {
      section,
      done,
      answered: inSection.filter((row) => row.answer).length,
      total: inSection.length,
      pct: pct(done, inSection.length),
      improvements: inSection
        .filter((row) => row.answer === "nao_feito")
        .map((row) => ({ groupName: row.groupName, text: row.text, note: row.note })),
    };
  });
  const done = rows.filter((row) => row.answer === "feito").length;
  return {
    done,
    answered: rows.filter((row) => row.answer).length,
    total: rows.length,
    pct: pct(done, rows.length),
    sections,
  };
}
