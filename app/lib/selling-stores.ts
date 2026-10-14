// Assistência e Depósito (CD) são setores internos, não lojas: não vendem nem
// emitem nota de venda. Regra única usada pelo Controle de Gorduras, Relatório
// NF, Checklists e Rotinas (rotas e worker/index.ts).
export function isSellingStore(name: string): boolean {
  const normalized = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return !(
    /\bassistencia\b/.test(normalized) || normalized.includes("assistance") ||
    /\bdeposito\b/.test(normalized) || normalized === "cd" || normalized.startsWith("cd ") ||
    normalized.includes("centro de distribuicao")
  );
}
