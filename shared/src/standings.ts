import { leaderboardScore, netWorth } from "./economy";
import { quoteCloseShort, shortsLiability } from "./shorts";
import type { Holding, Player, Short, Stock } from "./types";

export interface Standing {
  uid: string;
  /** cash + holdings − open-short liability (the ranked net worth). */
  netWorth: number;
  holdingsValue: number;
  score: number;
  /** 1-based leaderboard rank among active, non-idle players; null otherwise. */
  rank: number | null;
}

/**
 * Everyone's net worth, score and leaderboard rank, exactly as the
 * leaderboard shows them. Shared by the client (live) and `touch` (recap
 * snapshots) so both agree.
 */
export function computeStandings(
  players: Player[],
  stocks: Stock[],
  holdings: Holding[],
  openShorts: Short[],
  feePct: number,
): Map<string, Standing> {
  const stockById = new Map(stocks.map((s) => [s.id, s]));
  const priceOf = (id: string) => {
    const s = stockById.get(id);
    return s && s.listed ? s.price : undefined;
  };
  const holdingsOf = new Map<string, Holding[]>();
  for (const h of holdings) holdingsOf.set(h.uid, [...(holdingsOf.get(h.uid) ?? []), h]);
  const shortsOf = new Map<string, Short[]>();
  for (const s of openShorts) if (s.status === "open") shortsOf.set(s.ownerId, [...(shortsOf.get(s.ownerId) ?? []), s]);

  const liabilityOf = (uid: string) => {
    const list = shortsOf.get(uid);
    if (!list?.length) return 0;
    return shortsLiability(list, (i) => {
      const stock = stockById.get(list[i].stockId);
      if (!stock || !stock.listed || !(stock.poolShares > list[i].shares)) return undefined;
      try {
        return quoteCloseShort(stock, list[i].shares, feePct).cost;
      } catch {
        return undefined;
      }
    });
  };

  const out = new Map<string, Standing>();
  for (const p of players) {
    const holdingsValue = netWorth(p.cash, holdingsOf.get(p.uid) ?? [], priceOf) - p.cash;
    const nw = p.cash + holdingsValue - liabilityOf(p.uid);
    out.set(p.uid, { uid: p.uid, netWorth: nw, holdingsValue, score: leaderboardScore(nw, p.startingCash, p.totalAllowances), rank: null });
  }
  const ranked = players.filter((p) => p.isActive && !p.isIdle).sort((a, b) => out.get(b.uid)!.score - out.get(a.uid)!.score);
  ranked.forEach((p, i) => (out.get(p.uid)!.rank = i + 1));
  return out;
}
