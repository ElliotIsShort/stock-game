import type { Trade } from "./types";

/**
 * Unrealised profit/loss for a holding, from the player's own trade history.
 *
 * Cost basis uses the average-cost method: each buy adds its net cash spent
 * (what actually left the wallet, fee included) to the cost pool and its shares
 * to the share pool; each sell removes shares at the current average cost (so a
 * sell realises profit but doesn't change the average cost of what's left).
 * The result is marked against the current price.
 *
 * Trades may be passed in any order; they're sorted oldest-first here.
 */
export interface Position {
  /** Shares still held, per the trade history. */
  shares: number;
  /** Total cost of the shares still held (sum of net buy cash, less sold-share cost). */
  costBasis: number;
  /** Average price paid per share still held, or 0 when flat. */
  avgCost: number;
  /** shares × currentPrice. */
  marketValue: number;
  /** marketValue − costBasis. */
  unrealised: number;
  /** unrealised / costBasis, or 0 when there's no cost basis. */
  unrealisedPct: number;
}

export function positionFromTrades(trades: Trade[], currentPrice: number): Position {
  const ordered = [...trades].sort((a, b) => a.createdAt - b.createdAt);
  let shares = 0;
  let cost = 0;
  for (const t of ordered) {
    if (t.side === "buy") {
      // netCash is negative for buys: the cash that left the wallet.
      cost += Math.abs(t.netCash);
      shares += t.shares;
    } else {
      const avg = shares > 0 ? cost / shares : 0;
      const sold = Math.min(t.shares, shares);
      cost -= avg * sold;
      shares -= sold;
    }
  }
  // Clean up float dust around zero.
  if (shares < 1e-9) {
    shares = 0;
    cost = 0;
  }
  const marketValue = shares * currentPrice;
  const unrealised = marketValue - cost;
  return {
    shares,
    costBasis: cost,
    avgCost: shares > 0 ? cost / shares : 0,
    marketValue,
    unrealised,
    unrealisedPct: cost > 0 ? unrealised / cost : 0,
  };
}
