// Validação de CPF/CNPJ e formato de chave Pix — lógica pura, sem
// dependências, pra poder ser testada direto (ver tests/finance-payables.test.mjs).
// Usada só quando o campo é preenchido (documento/Pix continuam opcionais
// no cadastro de conta financeira).

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function cpfCheckDigit(digits: string, weightStart: number): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    sum += Number(digits[i]) * (weightStart - i);
  }
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

export function isValidCpf(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const d1 = cpfCheckDigit(digits.slice(0, 9), 10);
  const d2 = cpfCheckDigit(digits.slice(0, 10), 11);
  return d1 === Number(digits[9]) && d2 === Number(digits[10]);
}

function cnpjCheckDigit(digits: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) {
    sum += Number(digits[i]) * weights[i];
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCnpj(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
  const d1 = cnpjCheckDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = cnpjCheckDigit(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(digits[12]) && d2 === Number(digits[13]);
}

/** Aceita CPF (11 dígitos) ou CNPJ (14 dígitos), decidindo pelo tamanho. */
export function isValidCpfOrCnpj(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length === 11) return isValidCpf(value);
  if (digits.length === 14) return isValidCnpj(value);
  return false;
}

export const PIX_KEY_TYPES = ["cpf", "cnpj", "email", "phone", "random", "other"] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// UUID v4-like, formato padrão de chave aleatória do Pix.
const RANDOM_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidPixKey(key: string, type: PixKeyType): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  switch (type) {
    case "cpf":
      return isValidCpf(trimmed);
    case "cnpj":
      return isValidCnpj(trimmed);
    case "email":
      return EMAIL_PATTERN.test(trimmed);
    case "phone":
      return onlyDigits(trimmed).length >= 10 && onlyDigits(trimmed).length <= 13;
    case "random":
      return RANDOM_KEY_PATTERN.test(trimmed);
    case "other":
      return trimmed.length >= 3;
    default:
      return false;
  }
}
