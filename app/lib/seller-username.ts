// Usuário dos acessos de VENDEDORES E OPERACIONAIS (06/11/2026): só o PRIMEIRO
// e o SEGUNDO nome ("ANA MARIA DA SILVA" → "ana.maria"), sem acento e pulando
// DE/DA/DO/DAS/DOS/E. Repetido, a rota acrescenta .2, .3…
const PARTICLES = new Set(["de", "da", "do", "das", "dos", "e"]);

export function sellerUsernameBase(fullName: string): string {
  const parts = fullName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const names = parts.filter((part) => !PARTICLES.has(part));
  const base = (names.length ? names : parts).slice(0, 2).join(".").slice(0, 36);
  return base.length >= 3 ? base : `${base}.vendedor`;
}
