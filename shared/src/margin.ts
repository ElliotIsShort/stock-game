/**
 * Margin for open shorts: warn → margin call → forced liquidation (last
 * resort). Pure: the server applies the results, the client previews them.
 *
 *   coverCost = cash needed to buy back every open short at today's pools
 *   ok    coverCost <  shortWarnPct × cash
 *   warn  coverCost >= shortWarnPct × cash and coverCost <= cash
 *   call  coverCost >  cash   (shortfall = coverCost − cash)
 *
 * A short whose pool is too shallow to buy back counts as a call.
 */
import { quoteSell, type Pool } from "./amm";
import { quoteCloseShort } from "./shorts";
import type { MarginCall } from "./types";

export type MarginLevel = "ok" | "warn" | "call";

/** A margin call lasts this long before forced liquidation. */
export const MARGIN_CALL_MS = 7 * 24 * 3_600_000;
const CASH_EPS = 1e-6;

export interface MarginShort {
  stockId: string;
  shares: number;
}

export interface MarginStatus {
  level: MarginLevel;
  /** Cash needed to cover every open short now (coverable ones only). */
  coverCost: number;
  cash: number;
  /** coverCost − cash, rounded up to the penny; 0 unless called. */
  shortfall: number;
  /** Stocks whose pool is too shallow to buy the short back. */
  uncoverable: string[];
}

/** Round up to the next penny, so "raise £Y" is always enough. */
export function ceilPenny(n: number): number {
  return Math.ceil(n * 100 - 1e-7) / 100;
}

/**
 * Cash to buy back all of `shorts`. Shorts on the same stock are bought back
 * together: on a constant-product pool that costs the same as closing them one
 * after another (each later one pays the higher price), unlike quoting each alone.
 */
export function coverCost(shorts: MarginShort[], poolOf: (stockId: string) => Pool | undefined, feePct: number): { cost: number; uncoverable: string[] } {
  const byStock = new Map<string, number>();
  for (const s of shorts) byStock.set(s.stockId, (byStock.get(s.stockId) ?? 0) + s.shares);
  let cost = 0;
  const uncoverable: string[] = [];
  for (const [stockId, shares] of byStock) {
    const pool = poolOf(stockId);
    try {
      if (!pool) throw new Error("No pool");
      cost += quoteCloseShort(pool, shares, feePct).cost;
    } catch {
      uncoverable.push(stockId);
    }
  }
  return { cost, uncoverable };
}

export function marginStatus(
  cash: number,
  shorts: MarginShort[],
  poolOf: (stockId: string) => Pool | undefined,
  cfg: { tradingFeePct: number; shortWarnPct: number },
): MarginStatus {
  if (shorts.length === 0) return { level: "ok", coverCost: 0, cash, shortfall: 0, uncoverable: [] };
  const { cost, uncoverable } = coverCost(shorts, poolOf, cfg.tradingFeePct);
  const called = uncoverable.length > 0 || cost > cash + CASH_EPS;
  const level: MarginLevel = called ? "call" : cost >= cfg.shortWarnPct * cash ? "warn" : "ok";
  return { level, coverCost: cost, cash, shortfall: called ? ceilPenny(Math.max(0, cost - cash)) : 0, uncoverable };
}

// ---------- State transitions ----------

export interface MarginFlags {
  marginWarnedAt?: number;
  marginCall?: MarginCall;
}

/** What to tell the player: entering warn (from ok), being called, or clearing a call. */
export type MarginEvent = "warned" | "called" | "cleared" | null;

/**
 * The player's margin flags after a re-evaluation, and the event to announce.
 * The warning fires once, on ok → warn, until they're back to ok. A call keeps
 * its deadline while it lasts; only its shortfall tracks prices. `changed`
 * is false when nothing needs writing (shortfall moves under a penny don't count).
 */
export function nextMarginFlags(prev: MarginFlags, status: MarginStatus, now: number, callMs = MARGIN_CALL_MS): { flags: MarginFlags; event: MarginEvent; changed: boolean } {
  const wasCalled = Boolean(prev.marginCall);
  if (status.level === "ok") {
    return { flags: {}, event: wasCalled ? "cleared" : null, changed: wasCalled || prev.marginWarnedAt !== undefined };
  }
  const marginWarnedAt = prev.marginWarnedAt ?? now;
  if (status.level === "warn") {
    const event: MarginEvent = wasCalled ? "cleared" : prev.marginWarnedAt === undefined ? "warned" : null;
    return { flags: { marginWarnedAt }, event, changed: wasCalled || prev.marginWarnedAt === undefined };
  }
  const coverCostNow = Math.round(status.coverCost * 100) / 100;
  if (prev.marginCall) {
    const moved = Math.abs(prev.marginCall.shortfall - status.shortfall) >= 0.01;
    return {
      flags: { marginWarnedAt, marginCall: { ...prev.marginCall, shortfall: status.shortfall, coverCost: coverCostNow } },
      event: null,
      changed: moved || prev.marginWarnedAt === undefined,
    };
  }
  return {
    flags: { marginWarnedAt, marginCall: { calledAt: now, deadline: now + callMs, shortfall: status.shortfall, coverCost: coverCostNow } },
    event: "called",
    changed: true,
  };
}

// ---------- Forced liquidation ----------

export interface LiquidationHolding {
  stockId: string;
  shares: number;
}

export interface PlannedSale {
  stockId: string;
  shares: number;
  /** True when the whole holding is sold. */
  all: boolean;
  grossCash: number;
  fee: number;
  netCash: number;
  priceBefore: number;
  priceAfter: number;
  newPoolCash: number;
  newPoolShares: number;
}

export interface LiquidationPlan {
  sales: PlannedSale[];
  /** Cash after the sales, before buying the shorts back. */
  cashAfter: number;
  /** Cost to cover every short at the pools left after the sales. */
  coverCost: number;
  /** Cash after the sales covers every short. */
  solvent: boolean;
  /** The pools after the sales. */
  poolOf: (stockId: string) => Pool | undefined;
}

/**
 * The smallest forced sale that covers the player's shorts: holdings
 * largest-value first, selling only what's needed (the last one may be
 * partial), at the same AMM quotes and fee as a normal sell. The rest of the
 * portfolio is left alone. If selling everything isn't enough, `solvent` is
 * false and the caller falls back to bankruptcy settlement.
 *
 * Also used for the client's "sell enough to cover" preview.
 */
export function planLiquidation(
  cash: number,
  holdings: LiquidationHolding[],
  shorts: MarginShort[],
  poolOf: (stockId: string) => Pool | undefined,
  feePct: number,
): LiquidationPlan {
  const pools = new Map<string, Pool>();
  const pool = (id: string) => pools.get(id) ?? poolOf(id);
  const valued = holdings
    .filter((h) => h.shares > 0 && pool(h.stockId))
    .map((h) => ({ ...h, value: h.shares * (pool(h.stockId)!.poolCash / pool(h.stockId)!.poolShares) }))
    .sort((a, b) => b.value - a.value || a.stockId.localeCompare(b.stockId));

  let c = cash;
  const sales: PlannedSale[] = [];
  for (const h of valued) {
    const cover = coverCost(shorts, pool, feePct);
    if (cover.uncoverable.length === 0 && c + CASH_EPS >= cover.cost) break;
    const p = pool(h.stockId)!;
    let shares = h.shares;
    if (cover.uncoverable.length === 0) {
      // Sell just enough: net = (C − k/(S+s))(1−fee) = need  ⇒  s = k/(C − g) − S, g = need/(1−fee).
      // A penny of headroom absorbs float rounding. (Selling a stock you're also
      // short only makes covering cheaper, so this is never too little.)
      const need = cover.cost - c + 0.01;
      const g = need / (1 - feePct);
      if (g < p.poolCash) {
        const exact = (p.poolCash * p.poolShares) / (p.poolCash - g) - p.poolShares;
        if (exact > 0) shares = Math.min(h.shares, exact);
      }
    }
    const q = quoteSell(p, shares, feePct);
    const all = shares >= h.shares - 1e-12;
    sales.push({
      stockId: h.stockId,
      shares: all ? h.shares : shares,
      all,
      grossCash: q.grossCash,
      fee: q.fee,
      netCash: q.netCash,
      priceBefore: q.priceBefore,
      priceAfter: q.priceAfter,
      newPoolCash: q.newPoolCash,
      newPoolShares: q.newPoolShares,
    });
    c += q.netCash;
    pools.set(h.stockId, { poolCash: q.newPoolCash, poolShares: q.newPoolShares });
  }
  const final = coverCost(shorts, pool, feePct);
  return { sales, cashAfter: c, coverCost: final.cost, solvent: final.uncoverable.length === 0 && c + CASH_EPS >= final.cost, poolOf: pool };
}
