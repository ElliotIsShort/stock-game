import type { AlertDirection, SeenSnapshot, Trade } from "./types";

/** One trader's activity on your stock while you were away. */
export interface RecapTrader {
  traderId: string;
  traderName: string;
  bought: number;
  sold: number;
  shorted: number;
  covered: number;
}

/** "While you were away", returned by `touch` when you've been gone long enough. */
export interface Recap {
  since: number;
  netWorthThen: number | null;
  netWorthNow: number;
  rankThen: number | null;
  rankNow: number | null;
  /** Weekly closes that happened while away. */
  weeksClosed: number;
  /** Prizes you won in those closes. */
  prizes: { week: number; amount: number }[];
  /** Who traded your stock, biggest first. */
  traders: RecapTrader[];
  /** Your stock's price then (first trade's priceBefore) and now. */
  priceThen: number | null;
  priceNow: number | null;
  alertsTriggered: { stockName: string; direction: AlertDirection; price: number }[];
}

export interface TouchResult {
  player: boolean;
  reactivated: boolean;
  /** Snapshot from your previous session (before this one overwrote it). */
  previous: SeenSnapshot | null;
  recap: Recap | null;
}

/** Group trades on your stock by trader. Cash is gross (what moved through the pool). */
export function recapTraders(trades: Pick<Trade, "traderId" | "traderName" | "side" | "kind" | "cashAmount">[]): RecapTrader[] {
  const map = new Map<string, RecapTrader>();
  for (const t of trades) {
    const r = map.get(t.traderId) ?? { traderId: t.traderId, traderName: t.traderName, bought: 0, sold: 0, shorted: 0, covered: 0 };
    if (t.kind === "openShort") r.shorted += t.cashAmount;
    else if (t.kind === "closeShort") r.covered += t.cashAmount;
    else if (t.side === "buy") r.bought += t.cashAmount;
    else r.sold += t.cashAmount;
    map.set(t.traderId, r);
  }
  const size = (r: RecapTrader) => r.bought + r.sold + r.shorted + r.covered;
  return [...map.values()].sort((a, b) => size(b) - size(a));
}
