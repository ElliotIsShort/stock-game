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
  /** Profit/loss locked in by sells (net sale cash − average cost of the shares sold). */
  realised: number;
  /** When the current unbroken run of holding began (first buy, restarted by any sell), or null when flat. */
  holdingSince: number | null;
}

/**
 * Short opens/closes are recorded as trades too (`kind`), but they don't
 * touch your holdings, so they're ignored here.
 */
export function positionFromTrades(trades: Pick<Trade, "side" | "shares" | "netCash" | "createdAt" | "kind">[], currentPrice: number): Position {
  const ordered = trades.filter((t) => !t.kind).sort((a, b) => a.createdAt - b.createdAt);
  let shares = 0;
  let cost = 0;
  let realised = 0;
  let since: number | null = null;
  for (const t of ordered) {
    if (t.side === "buy") {
      // netCash is negative for buys: the cash that left the wallet.
      cost += Math.abs(t.netCash);
      if (shares <= 1e-9) since = t.createdAt;
      shares += t.shares;
    } else {
      const avg = shares > 0 ? cost / shares : 0;
      const sold = Math.min(t.shares, shares);
      cost -= avg * sold;
      realised += t.netCash * (t.shares > 0 ? sold / t.shares : 0) - avg * sold;
      shares -= sold;
      since = t.createdAt;
    }
  }
  // Clean up float dust around zero.
  if (shares < 1e-9) {
    shares = 0;
    cost = 0;
    since = null;
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
    realised,
    holdingSince: since,
  };
}
