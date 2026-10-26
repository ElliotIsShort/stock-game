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

/** A player in the running for the weekly prize. */
export interface PrizeCandidate {
  playerId: string;
  name: string;
  /** weeklyGrowth for the week being closed. */
  growth: number;
  netWorthStart: number;
  isIdle: boolean;
}

export interface PrizeWinner {
  playerId: string;
  name: string;
  growth: number;
  prizeAmount: number;
}

/**
 * The split actually used for `winnerCount` winners: the first
 * min(winnerCount, splitPct.length) entries, rescaled to sum to 1.
 */
export function prizeSplit(winnerCount: number, splitPct: readonly number[]): number[] {
  const used = splitPct.slice(0, Math.max(0, Math.min(winnerCount, splitPct.length)));
  const total = used.reduce((a, b) => a + b, 0);
  // Config validation keeps the first entry positive; fall back to an even split rather than divide by zero.
  if (!(total > 0)) return used.map(() => 1 / used.length);
  return used.map((s) => s / total);
}

/**
 * §5 weekly prize: non-idle players with a positive start-of-week net worth,
 * ranked by weekly growth (highest first). The top N = min(eligible,
 * splitPct.length) share the whole pool by the rescaled split. Empty when
 * nobody is eligible (the pool rolls over). The last winner absorbs float
 * rounding so the amounts always add up to the full pool.
 */
export function weeklyPrizeWinners(candidates: readonly PrizeCandidate[], prizePool: number, splitPct: readonly number[]): PrizeWinner[] {
  const ranked = candidates.filter((c) => !c.isIdle && c.netWorthStart > 0).sort((a, b) => b.growth - a.growth);
  const split = prizeSplit(ranked.length, splitPct);
  let paid = 0;
  return split.map((share, i) => {
    const c = ranked[i];
    const prizeAmount = i === split.length - 1 ? prizePool - paid : prizePool * share;
    paid += prizeAmount;
    return { playerId: c.playerId, name: c.name, growth: c.growth, prizeAmount };
  });
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
/** Keep roughly two years of weekly net-worth samples per player. */
export const NET_WORTH_HISTORY_MAX = 104;

export const SHARE_EPSILON = 1e-9;
export const CASH_EPSILON = 1e-6;

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
