import type { GameConfig } from "./types";

/** §4.1: startingCash(joinWeek) = baseStartingCash + (joinWeek − 1) × weeklyAllowance */
export function startingCash(joinWeek: number, cfg: Pick<GameConfig, "baseStartingCash" | "weeklyAllowance">): number {
  return cfg.baseStartingCash + Math.max(0, joinWeek - 1) * cfg.weeklyAllowance;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** §4.2: first stocks list at baseStockPrice, later ones at the median listed price. */
export function listingPrice(listedPrices: number[], baseStockPrice: number): number {
  return median(listedPrices) ?? baseStockPrice;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Net worth = cash + Σ shares × current price (marked at spot price). */
export function netWorth(cash: number, holdings: { stockId: string; shares: number }[], priceOf: (stockId: string) => number | undefined): number {
  let total = cash;
  for (const h of holdings) {
    const p = priceOf(h.stockId);
    if (p !== undefined) total += h.shares * p;
  }
  return total;
}

/** §5: score = netWorth / (startingCash + Σ allowances). CEO bonus is not in the denominator. */
export function leaderboardScore(netWorthValue: number, startingCashValue: number, totalAllowances: number): number {
  const denom = startingCashValue + totalAllowances;
  return denom > 0 ? netWorthValue / denom : 0;
}

/** §5: weeklyGrowth = (netWorthEnd − netWorthStart − allowanceThisWeek) / netWorthStart */
export function weeklyGrowth(netWorthStart: number, netWorthEnd: number, allowanceThisWeek: number): number {
  if (!(netWorthStart > 0)) return 0;
  return (netWorthEnd - netWorthStart - allowanceThisWeek) / netWorthStart;
}

/** §3: bonus(P) = bonusRate × Σ (shares of P held by others × price of P) */
export function ceoBonus(sharesHeldByOthers: number, price: number, bonusRate: number): number {
  return bonusRate * sharesHeldByOthers * price;
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function isIdleSince(lastActiveAt: number, now: number, idleThresholdWeeks: number): boolean {
  return now - lastActiveAt >= idleThresholdWeeks * WEEK_MS;
}

/** Tiny amounts left over from float math are treated as zero. */
export const SHARE_EPSILON = 1e-9;
export const CASH_EPSILON = 1e-6;

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
