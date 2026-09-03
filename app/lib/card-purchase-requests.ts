// Lógica pura das compras em cartão cadastradas pela Assistência
// (itens 8-10). Sem I/O — validação do rascunho e vocabulário de status.
// A rota (app/api/finance/card-purchase-requests/*) faz o SQL e a cópia
// para finance_card_invoice_entries na aprovação.

export const CARD_PURCHASE_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
export type CardPurchaseRequestStatus = (typeof CARD_PURCHASE_REQUEST_STATUSES)[number];

export function isCardPurchaseRequestStatus(value: unknown): value is CardPurchaseRequestStatus {
  return (
    typeof value === "string" &&
    (CARD_PURCHASE_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

export const CARD_KINDS = ["corporate", "partner"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export function isCardKind(value: unknown): value is CardKind {
  return typeof value === "string" && (CARD_KINDS as readonly string[]).includes(value);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normaliza o parcelamento informado (parcela atual / total). Sem
 * parcelamento vira 1/1. total nunca menor que a parcela atual.
 */
export function normalizeInstallments(
  current: unknown,
  total: unknown,
): { current: number; total: number; label: string } {
  const parsedTotal = Math.max(1, Math.trunc(Number(total) || 1));
  const parsedCurrent = Math.min(
    parsedTotal,
    Math.max(1, Math.trunc(Number(current) || 1)),
  );
  return {
    current: parsedCurrent,
    total: parsedTotal,
    label: parsedTotal > 1 ? `${parsedCurrent}/${parsedTotal}` : "",
  };
}

/**
 * Valida os campos obrigatórios de uma compra cadastrada pela Assistência.
 * Devolve a mensagem de erro (em CAIXA ALTA, padrão do projeto) ou null.
 */
export function validateCardPurchaseDraft(draft: {
  cardId: string;
  purchaseDate: string;
  merchant: string;
  amountCents: number;
  installmentTotal: number;
}): string | null {
  if (!draft.cardId) return "SELECIONE O CARTÃO.";
  if (!DATE_RE.test(draft.purchaseDate)) return "INFORME A DATA DA COMPRA.";
  if (!draft.merchant.trim()) return "INFORME O ESTABELECIMENTO.";
  if (!Number.isFinite(draft.amountCents) || draft.amountCents <= 0) {
    return "INFORME UM VALOR MAIOR QUE ZERO.";
  }
  if (!Number.isInteger(draft.installmentTotal) || draft.installmentTotal < 1 || draft.installmentTotal > 48) {
    return "NÚMERO DE PARCELAS INVÁLIDO (1 A 48).";
  }
  return null;
}
