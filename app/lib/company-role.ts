// Papel de uma unidade do Cadastro de Lojas pelo NOME — mesma regra do front
// (pullCompanyRole + isOfficeCompany em public/estoque.html).
export type CompanyRole = "store" | "depot" | "assistance" | "office";

export function companyRole(name: string): CompanyRole {
  const key = String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(da|de|do|das|dos)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\bassistencia\b/.test(key) || key.includes("assistance")) return "assistance";
  if (/\bdeposito\b/.test(key) || key === "cd" || key.startsWith("cd ") || key.includes("centro distribuicao")) return "depot";
  if (/^escritorio\b/.test(key)) return "office";
  return "store";
}
