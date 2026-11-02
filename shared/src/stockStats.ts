import type { Holding, Stock } from "./types";

export interface PriceTick {
  /** Fields to merge into the stock doc. */
  patch: Pick<Stock, "allTimeHigh" | "allTimeLow"> & Partial<Pick<Stock, "athAnnouncedWeek" | "atlAnnouncedWeek">>;
  announceHigh: boolean;
  announceLow: boolean;
}

/**
 * Bookkeeping for one price change: track all-time highs/lows. (Stocks used
 * to keep a list of recent prices for the feed sparkline; that's gone, and old
 * docs' stale `recentPrices` field is dropped at the next weekly close.)
 * A new record is announced at most once per stock per week, and
 * only once the stock has been through a weekly close (so a fresh listing's
 * first sell isn't an "all-time low"). Stocks from before these fields existed
 * start from the best record we have (list price + this week's range) and the
 * initialising tick never announces.
 */
export function priceTick(
  stock: Pick<Stock, "price" | "listPrice" | "weekHigh" | "weekLow" | "weekOpenPrice" | "listedWeek" | "allTimeHigh" | "allTimeLow" | "athAnnouncedWeek" | "atlAnnouncedWeek">,
  priceAfter: number,
  week: number,
): PriceTick {
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
      allTimeHigh: Math.max(ath, priceAfter),
      allTimeLow: Math.min(atl, priceAfter),
      ...(announceHigh ? { athAnnouncedWeek: week } : {}),
      ...(announceLow ? { atlAnnouncedWeek: week } : {}),
    },
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
