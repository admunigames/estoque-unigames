// CONCILIAÇÃO DE CONTAS A RECEBER (23/10/2026) — previsto × o que entrou
// na conta bancária. Lógica pura, sem banco.
//
// Sugestão de par recebível ↔ crédito do extrato, um para um:
//  1ª passada: valor IGUAL e data do crédito até `windowDays` dias da data
//     prevista (o mais próximo ganha);
//  2ª passada: valor PARECIDO (diferença até 2% ou R$ 1,00) na mesma janela —
//     sugere, mas aparece como VALOR DIFERENTE para o usuário conferir.

export type ReconReceivable = { id: string; expectedDate: string; expectedAmountCents: number };
export type ReconCredit = { id: string; entryDate: string; amountCents: number };
export type ReconSuggestion = { receivableId: string; entryId: string; exact: boolean };

function dayNumber(date: string) {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function closeAmount(expected: number, actual: number) {
  return Math.abs(expected - actual) <= Math.max(100, Math.round(Math.abs(expected) * 0.02));
}

export function suggestReceivableMatches(
  receivables: ReconReceivable[],
  credits: ReconCredit[],
  windowDays = 5,
): ReconSuggestion[] {
  const used = new Set<string>();
  const result: ReconSuggestion[] = [];
  const pending = [...receivables].sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.id.localeCompare(b.id));
  for (const exact of [true, false]) {
    for (const receivable of pending) {
      if (result.some((row) => row.receivableId === receivable.id)) continue;
      let best: { credit: ReconCredit; distance: number } | null = null;
      for (const credit of credits) {
        if (used.has(credit.id)) continue;
        const sameAmount = credit.amountCents === receivable.expectedAmountCents;
        if (exact ? !sameAmount : sameAmount || !closeAmount(receivable.expectedAmountCents, credit.amountCents)) continue;
        const distance = Math.abs(dayNumber(credit.entryDate) - dayNumber(receivable.expectedDate));
        if (distance > windowDays) continue;
        if (!best || distance < best.distance || (distance === best.distance && credit.id < best.credit.id)) {
          best = { credit, distance };
        }
      }
      if (!best) continue;
      used.add(best.credit.id);
      result.push({ receivableId: receivable.id, entryId: best.credit.id, exact });
    }
  }
  return result;
}
