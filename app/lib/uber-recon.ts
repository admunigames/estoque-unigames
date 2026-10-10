// Conciliação Uber (Cartões Corporativos): corridas anotadas (planilha
// importada) × cobranças UBER da fatura do cartão. Regra pura, sem I/O.

export const UBER_MATCH_DAYS = 1;

export type UberRide = { id: string; rideDate: string; amountCents: number };
export type UberCharge = { id: string; entryDate: string; amountCents: number };

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** A cobrança é da Uber pelo nome do estabelecimento na fatura (UBER, UBER *TRIP, UBER DO BRASIL…). */
export function isUberMerchant(merchant: string): boolean {
  return /\bUBER\b/.test(String(merchant || "").toUpperCase());
}

/**
 * Casa corridas e cobranças ainda livres: mesmo valor e até UBER_MATCH_DAYS
 * de diferença na data, a menor diferença primeiro (empate: a mais antiga).
 * Cada cobrança casa com uma corrida só. Devolve pares { rideId, chargeId }.
 */
export function matchUberRides(rides: UberRide[], charges: UberCharge[]): Array<{ rideId: string; chargeId: string }> {
  const candidates: Array<{ rideId: string; chargeId: string; diff: number; date: string }> = [];
  for (const ride of rides) {
    for (const charge of charges) {
      if (charge.amountCents !== ride.amountCents) continue;
      const diff = daysBetween(ride.rideDate, charge.entryDate);
      if (diff <= UBER_MATCH_DAYS) candidates.push({ rideId: ride.id, chargeId: charge.id, diff, date: ride.rideDate });
    }
  }
  candidates.sort((a, b) => a.diff - b.diff || a.date.localeCompare(b.date) || a.rideId.localeCompare(b.rideId) || a.chargeId.localeCompare(b.chargeId));
  const usedRides = new Set<string>();
  const usedCharges = new Set<string>();
  const pairs: Array<{ rideId: string; chargeId: string }> = [];
  for (const item of candidates) {
    if (usedRides.has(item.rideId) || usedCharges.has(item.chargeId)) continue;
    usedRides.add(item.rideId);
    usedCharges.add(item.chargeId);
    pairs.push({ rideId: item.rideId, chargeId: item.chargeId });
  }
  return pairs;
}
