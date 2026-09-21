// RH > Fardamento — lógica pura (sem dependência de banco/ambiente),
// reaproveitada por app/api/hr-uniform-stock/shared.ts e testada
// diretamente em tests/hr-uniform-stock.test.mjs.

export const PIECE_TYPES = ["unitec", "unigames", "pa", "lider", "adm", "casacos"] as const;
export type PieceType = (typeof PIECE_TYPES)[number];

export const PIECE_TYPE_LABELS: Record<PieceType, string> = {
  unitec: "Unitec",
  unigames: "Unigames",
  pa: "P.A",
  lider: "Líder (preta)",
  adm: "ADM",
  casacos: "Casacos",
};

export const SIZES = ["P", "M", "G", "GG", "XGG", "XXGG"] as const;
export type Size = (typeof SIZES)[number];

export const MOVEMENT_TYPES = ["saida", "entrada", "ajuste"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const TERM_STATUSES = ["aguardando_assinatura", "enviado", "assinado"] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

export function isPieceType(value: string): value is PieceType {
  return (PIECE_TYPES as readonly string[]).includes(value);
}

export function isSize(value: string): value is Size {
  return (SIZES as readonly string[]).includes(value);
}

export function isMovementType(value: string): value is MovementType {
  return (MOVEMENT_TYPES as readonly string[]).includes(value);
}

export function isTermStatus(value: string): value is TermStatus {
  return (TERM_STATUSES as readonly string[]).includes(value);
}

export function stockItemId(pieceType: string, size: string) {
  return `${pieceType}:${size}`;
}

// "quantity" gravado em uniform_stock_movements é sempre o DELTA já
// assinado que será aplicado ao saldo (nunca um valor absoluto) — saída
// fixa -1, entrada fixa +1, ajuste é o delta livre informado (o front-end
// calcula esse delta a partir da diferença entre o saldo exibido e o novo
// valor desejado). Isso garante `stock_qty = stock_qty + delta` num único
// UPDATE relativo, sem condição de corrida em lançamentos simultâneos.
export function resolveMovementDelta(movementType: MovementType, adjustmentQuantity: number) {
  if (movementType === "saida") return -1;
  if (movementType === "entrada") return 1;
  return adjustmentQuantity;
}
