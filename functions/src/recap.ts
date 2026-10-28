import { onCall } from "firebase-functions/v2/https";
import {
  computeStandings,
  mergeConfig,
  recapTraders,
  reportWinners,
  type GameState,
  type Holding,
  type Player,
  type PriceAlert,
  type Recap,
  type SeenSnapshot,
  type Short,
  type Stock,
  type TouchResult,
  type Trade,
  type WeeklyReport,
} from "@fsm/shared";
import { db, refs, requireAuth } from "./common";

const HOUR_MS = 3_600_000;

/**
 * Called by the client once per session. Records activity, silently
 * reactivates idle players (§5: no back-pay), snapshots net worth and rank
 * for next time, and, after `recapAfterHours` away, returns a "while you
 * were away" recap. `previous` (the last session's snapshot) lets the client
 * decide on moments: weekly results and "you took #1".
 */
export const touch = onCall(async (req): Promise<TouchResult> => {
  const uid = requireAuth(req);
  const now = Date.now();

  const meSnap = await refs.player(uid).get();
  if (!meSnap.exists) return { player: false, reactivated: false, previous: null, recap: null };
  const me = meSnap.data() as Player;
  if (!me.isActive) return { player: true, reactivated: false, previous: me.seenSnapshot ?? null, recap: null };

  // Friend-group scale: reading everything once per session is cheap.
  const [playersSnap, stocksSnap, holdingsSnap, shortsSnap, configSnap, stateSnap] = await Promise.all([
    db.collection("players").get(),
    db.collection("stocks").get(),
    db.collection("holdings").get(),
    db.collection("shorts").where("status", "==", "open").get(),
    refs.config().get(),
    refs.state().get(),
  ]);
  const cfg = mergeConfig(configSnap.data());
  const state = stateSnap.data() as GameState | undefined;
  const stocks = stocksSnap.docs.map((d) => d.data() as Stock);
  // Score as of now, with this session's activity clearing idle.
  const players = playersSnap.docs.map((d) => d.data() as Player).map((p) => (p.uid === uid ? { ...p, isIdle: false } : p));
  const standings = computeStandings(players, stocks, holdingsSnap.docs.map((d) => d.data() as Holding), shortsSnap.docs.map((d) => d.data() as Short), cfg.tradingFeePct);
  const mine = standings.get(uid)!;
  const week = state?.currentWeek ?? 1;
  const previous = me.seenSnapshot ?? null;
  const snapshot: SeenSnapshot = { at: now, netWorth: mine.netWorth, rank: mine.rank, week };

  const since = me.lastActiveAt;
  const recap = now - since >= cfg.recapAfterHours * HOUR_MS ? await buildRecap(uid, since, previous, mine, week, stocks) : null;

  await refs.player(uid).update({ lastActiveAt: now, isIdle: false, seenSnapshot: snapshot });
  return { player: true, reactivated: me.isIdle, previous, recap };
});

async function buildRecap(
  uid: string,
  since: number,
  previous: SeenSnapshot | null,
  mine: { netWorth: number; rank: number | null },
  week: number,
  stocks: Stock[],
): Promise<Recap> {
  const [tradesSnap, reportsSnap, alertsSnap] = await Promise.all([
    db.collection("trades").where("stockId", "==", uid).where("createdAt", ">", since).orderBy("createdAt", "desc").limit(200).get(),
    db.collection("weeklyReports").where("periodEnd", ">", since).get(),
    db.collection("alerts").where("uid", "==", uid).where("status", "==", "triggered").get(),
  ]);
  const trades = tradesSnap.docs.map((d) => d.data() as Trade).filter((t) => t.traderId !== uid);
  const reports = reportsSnap.docs.map((d) => d.data() as WeeklyReport).sort((a, b) => a.week - b.week);
  const myStock = stocks.find((s) => s.id === uid);
  const oldest = trades.at(-1);
  return {
    since,
    netWorthThen: previous?.netWorth ?? null,
    netWorthNow: mine.netWorth,
    rankThen: previous?.rank ?? null,
    rankNow: mine.rank,
    weeksClosed: previous ? Math.max(0, week - previous.week) : reports.length,
    prizes: reports.flatMap((r) => reportWinners(r).filter((w) => w.playerId === uid).map((w) => ({ week: r.week, amount: w.prizeAmount }))),
    traders: recapTraders(trades).slice(0, 8),
    priceThen: oldest ? oldest.priceBefore : null,
    priceNow: myStock?.price ?? null,
    alertsTriggered: alertsSnap.docs
      .map((d) => d.data() as PriceAlert)
      .filter((a) => (a.triggeredAt ?? 0) > since)
      .map((a) => ({ stockName: a.stockName, direction: a.direction, price: a.price })),
  };
}
