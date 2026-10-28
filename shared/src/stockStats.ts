import type { Holding, Stock } from "./types";

/** How many recent prices each stock keeps for feed sparklines. */
export const RECENT_PRICES_MAX = 24;

export interface PriceTick {
  /** Fields to merge into the stock doc. */
  patch: Pick<Stock, "recentPrices" | "allTimeHigh" | "allTimeLow"> & Partial<Pick<Stock, "athAnnouncedWeek" | "atlAnnouncedWeek">>;
  /** The stock's recent prices after this tick (also stored on the trade). */
  recentPrices: number[];
  announceHigh: boolean;
  announceLow: boolean;
}

/**
 * Bookkeeping for one price change: append to recent prices and track all-time
 * highs/lows. A new record is announced at most once per stock per week, and
 * only once the stock has been through a weekly close (so a fresh listing's
 * first sell isn't an "all-time low"). Stocks from before these fields existed
 * start from the best record we have (list price + this week's range) and the
 * initialising tick never announces.
 */
export function priceTick(
  stock: Pick<Stock, "price" | "listPrice" | "weekHigh" | "weekLow" | "weekOpenPrice" | "listedWeek" | "recentPrices" | "allTimeHigh" | "allTimeLow" | "athAnnouncedWeek" | "atlAnnouncedWeek">,
  priceAfter: number,
  week: number,
): PriceTick {
  const recentPrices = [...(stock.recentPrices?.length ? stock.recentPrices : [stock.price]), priceAfter].slice(-RECENT_PRICES_MAX);
  const initialising = stock.allTimeHigh === undefined || stock.allTimeLow === undefined;
  const ath = stock.allTimeHigh ?? Math.max(stock.listPrice, stock.weekHigh, stock.weekOpenPrice, stock.price);
  const atl = stock.allTimeLow ?? Math.min(stock.listPrice, stock.weekLow, stock.weekOpenPrice, stock.price);
  const seasoned = stock.listedWeek < week && !initialising;
  const newHigh = priceAfter > ath;
  const newLow = priceAfter < atl;
  const announceHigh = newHigh && seasoned && stock.athAnnouncedWeek !== week;
  const announceLow = newLow && seasoned && stock.atlAnnouncedWeek !== week;
  return {
    patch: {
      recentPrices,
      allTimeHigh: Math.max(ath, priceAfter),
      allTimeLow: Math.min(atl, priceAfter),
      ...(announceHigh ? { athAnnouncedWeek: week } : {}),
      ...(announceLow ? { atlAnnouncedWeek: week } : {}),
    },
    recentPrices,
    announceHigh,
    announceLow,
  };
}

/**
 * Holding bookkeeping for awards (average-cost basis and Diamond Hands).
 * Buys add their cash to the cost and keep the holding run going; any sell
 * removes shares at average cost and restarts the run.
 */
export function holdingAfterBuy(prev: Pick<Holding, "shares" | "costBasis" | "holdingSince"> | null, shares: number, cashSpent: number, now: number) {
  const held = prev?.shares ?? 0;
  return {
    shares: held + shares,
    costBasis: (held > 0 ? (prev?.costBasis ?? 0) : 0) + cashSpent,
    holdingSince: held > 0 ? (prev?.holdingSince ?? now) : now,
  };
}

export function holdingAfterSell(prev: Pick<Holding, "shares" | "costBasis">, sold: number, now: number) {
  const remaining = Math.max(0, prev.shares - sold);
  const avg = prev.shares > 0 ? (prev.costBasis ?? 0) / prev.shares : 0;
  return { shares: remaining, costBasis: Math.max(0, avg * remaining), holdingSince: now };
}
