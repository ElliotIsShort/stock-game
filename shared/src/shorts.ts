import { quoteBuy, quoteSell, type Pool } from "./amm";
import { roundMoney } from "./economy";
import type { Short } from "./types";

/**
 * Synthetic short selling against the AMM. Opening a short sells `shares` into
 * the pool (price falls, you receive cash). Closing buys them back (price
 * rises, you pay cash). Profit comes from closing below where you opened.
 * No shares are borrowed from anyone — the AMM is the counterparty, so the
 * short-seller eats the same price impact and fees as a sell then a buy.
 */

export interface OpenShortQuote {
  shares: number;
  /** Cash received now, net of the opening fee. */
  proceeds: number;
  fee: number;
  priceBefore: number;
  priceAfter: number;
  newPoolCash: number;
  newPoolShares: number;
}

export interface CloseShortQuote {
  shares: number;
  /** Cash needed to buy the shares back, incl. the closing fee. */
  cost: number;
  fee: number;
  priceBefore: number;
  priceAfter: number;
  newPoolCash: number;
  newPoolShares: number;
}

/** Opening a short = selling `shares` into the pool. */
export function quoteOpenShort(pool: Pool, shares: number, feePct: number): OpenShortQuote {
  const q = quoteSell(pool, shares, feePct);
  return {
    shares,
    proceeds: q.netCash,
    fee: q.fee,
    priceBefore: q.priceBefore,
    priceAfter: q.priceAfter,
    newPoolCash: q.newPoolCash,
    newPoolShares: q.newPoolShares,
  };
}

/**
 * Closing a short = buying `shares` back from the pool. The AMM is priced by
 * cash in, so we solve for the gross cash that extracts exactly `shares`, then
 * add the fee on top (buy fees come off the top, so grossSpend = net / (1-fee)).
 */
export function quoteCloseShort(pool: Pool, shares: number, feePct: number): CloseShortQuote {
  if (!(shares > 0)) throw new Error("Shares must be positive");
  if (!(pool.poolShares > shares)) throw new Error("Pool too shallow to close this short");
  const k = pool.poolCash * pool.poolShares;
  const newPoolShares = pool.poolShares - shares;
  const newPoolCash = k / newPoolShares;
  const netToPool = newPoolCash - pool.poolCash; // cash that must enter the pool
  const grossSpend = feePct < 1 ? netToPool / (1 - feePct) : netToPool;
  const fee = grossSpend - netToPool;
  return {
    shares,
    cost: grossSpend,
    fee,
    priceBefore: pool.poolCash / pool.poolShares,
    priceAfter: newPoolCash / newPoolShares,
    newPoolCash,
    newPoolShares,
  };
}

/** Live profit/loss if this open short were closed now at `cost` to buy back. */
export function shortUnrealised(short: Pick<Short, "openProceeds" | "borrowFeesPaid">, closeCostNow: number): number {
  return roundMoney(short.openProceeds - closeCostNow - short.borrowFeesPaid);
}

/** Current mark-to-market value of an open short's shares (for exposure/fee calc). */
export function shortExposure(shares: number, price: number): number {
  return shares * price;
}

/**
 * A player's capital for the exposure cap: cash + value of their holdings.
 * Open-short paper gains are deliberately excluded so a short can't fund a
 * bigger short.
 */
export function shortableCapital(cash: number, holdingsValue: number): number {
  return cash + holdingsValue;
}

/** Weekly borrow fee charged on an open short's current value. */
export function shortBorrowFee(shares: number, price: number, feePct: number): number {
  return roundMoney(shares * price * feePct);
}

/**
 * Net-worth liability of a single open short (Option B: an open short can only
 * hurt net worth, never help it, so it can't be used to game the leaderboard).
 *
 * Opening a short put `openProceeds` of cash into the wallet. To make opening
 * net-worth-neutral we subtract at least that much back off as a liability.
 * If the short is underwater (buying back now costs more than received), the
 * liability is the higher buy-back cost, dragging net worth down. If it's in
 * profit, the liability is clamped to the proceeds — the paper gain is ignored
 * until the short is actually closed.
 *
 * `closeCostNow` is the live cost to buy the shares back from the pool. When
 * the pool is too shallow to price a close, pass undefined and we fall back to
 * the proceeds (neutral), never a gain.
 */
export function shortLiability(openProceeds: number, closeCostNow: number | undefined): number {
  if (closeCostNow === undefined || !Number.isFinite(closeCostNow)) return openProceeds;
  return Math.max(openProceeds, closeCostNow);
}

/**
 * Total net-worth liability across a player's open shorts, using a function
 * that prices the live buy-back cost per short (or returns undefined when it
 * can't be priced). Subtract this from cash + holdings for the ranked net worth.
 */
export function shortsLiability(
  shorts: { openProceeds: number }[],
  closeCostOf: (index: number) => number | undefined,
): number {
  let total = 0;
  shorts.forEach((s, i) => {
    total += shortLiability(s.openProceeds, closeCostOf(i));
  });
  return roundMoney(total);
}
