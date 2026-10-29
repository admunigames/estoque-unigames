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

// Lojas fora da Rotina Operacional (rotinas, Check-in/Check-out/Troca de
// Turno): P.A LOJA deixou de ser loja e virou estoque (usuário, 29/10/2026).
// Por id, para não depender do nome.
const NON_ROUTINE_STORE_IDS = new Set(["cmrvhi891nt7hz"]);

export function isRoutineStore(company: { id: string; name: string }): boolean {
  return isSellingStore(company.name) && !NON_ROUTINE_STORE_IDS.has(company.id);
}
