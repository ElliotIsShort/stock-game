import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import type { DocumentReference, DocumentSnapshot, QuerySnapshot } from "firebase-admin/firestore";
import {
  computeStandings,
  mergeConfig,
  pushSeriesPoint,
  seriesDocId,
  type GameConfig,
  type Holding,
  type NetWorthSeries,
  type Player,
  type Short,
  type Stock,
} from "@fsm/shared";
import { db, refs } from "./common";
import { reevaluateMargin } from "./margin";

export const seriesRef = (uid: string, week: number) => db.doc(`netWorthSeries/${seriesDocId(uid, week)}`) as DocumentReference<NetWorthSeries>;

/** Firestore bills at least one read per query, even an empty one, and one per document returned. */
const queryReads = (s: QuerySnapshot) => Math.max(1, s.size);
const IN_LIMIT = 30;

/**
 * Everything the net worth of the players affected by one trade depends on.
 * "Affected" = holders of the traded stock, players short it, and the trader.
 */
export interface AffectedWorld {
  cfg: GameConfig;
  /** The affected players. */
  players: Player[];
  /** All holdings of the affected players. */
  holdings: Holding[];
  /** Every open short in the market (a handful at friend scale). */
  openShorts: Short[];
  /** The stocks those holdings and shorts are in. */
  stocks: Stock[];
  /** Firestore reads this load cost. */
  reads: number;
}

/**
 * Targeted load for one trade. Reads, with H = holders of the stock, S = open
 * shorts, A = affected players, ΣA = their holdings, R = stocks they touch:
 *   1 (config) + H + S + A + ΣA + R   (each query costs at least 1).
 * The traded stock itself comes from the trigger event, not a read.
 */
export async function loadAffected(stock: Stock, traderId: string): Promise<AffectedWorld> {
  const [cfgSnap, holdersSnap, shortsSnap] = await Promise.all([
    refs.config().get(),
    db.collection("holdings").where("stockId", "==", stock.id).get(),
    db.collection("shorts").where("status", "==", "open").get(),
  ]);
  let reads = 1 + queryReads(holdersSnap) + queryReads(shortsSnap);
  const cfg = mergeConfig(cfgSnap.data());
  const openShorts = shortsSnap.docs.map((d) => d.data() as Short);

  const uids = [...new Set([traderId, ...holdersSnap.docs.map((d) => (d.data() as Holding).uid), ...openShorts.filter((s) => s.stockId === stock.id).map((s) => s.ownerId)])];
  const playerSnaps: DocumentSnapshot[] = uids.length ? await db.getAll(...uids.map((u) => refs.player(u))) : [];
  reads += playerSnaps.length;
  const players = playerSnaps.filter((s) => s.exists).map((s) => s.data() as Player);

  const holdings: Holding[] = [];
  for (let i = 0; i < players.length; i += IN_LIMIT) {
    const chunk = players.slice(i, i + IN_LIMIT).map((p) => p.uid);
    const snap = await db.collection("holdings").where("uid", "in", chunk).get();
    reads += queryReads(snap);
    holdings.push(...snap.docs.map((d) => d.data() as Holding));
  }

  const mine = new Set(players.map((p) => p.uid));
  const stockIds = [...new Set([...holdings.map((h) => h.stockId), ...openShorts.filter((s) => mine.has(s.ownerId)).map((s) => s.stockId)])].filter((id) => id !== stock.id);
  const stockSnaps = stockIds.length ? await db.getAll(...stockIds.map((id) => refs.stock(id))) : [];
  reads += stockSnaps.length;
  const stocks = [stock, ...stockSnaps.filter((s) => s.exists).map((s) => s.data() as Stock)];

  return { cfg, players, holdings, openShorts, stocks, reads };
}

/**
 * Coalesce one net-worth point into a player's series doc for `week`. A
 * transaction (1 read, ≤1 write) so two triggers can't clobber each other.
 */
export async function recordSeriesPoint(uid: string, week: number, v: number, t: number, windowMs: number): Promise<{ reads: number; writes: number }> {
  return db.runTransaction(async (tx) => {
    const ref = seriesRef(uid, week);
    const snap = await tx.get(ref);
    const cur = snap.data();
    const next = pushSeriesPoint({ points: cur?.points ?? [], openSince: cur?.openSince }, { t, v }, windowMs);
    if (!next.changed) return { reads: 1, writes: 0 };
    const doc: NetWorthSeries = { uid, week, points: next.points, updatedAt: t, ...(next.openSince !== undefined ? { openSince: next.openSince } : {}) };
    tx.set(ref, doc);
    return { reads: 1, writes: 1 };
  });
}

/**
 * Runs after every price-moving trade (`stocks/{id}.lastTrade` changed), not
 * on weekly-close bookkeeping or ticker edits. Records a net-worth point for
 * everyone the trade affected, and re-evaluates margin for those of them with
 * open shorts (or an existing warning/call).
 *
 * LOOP SAFETY: this must never write to `stocks/*` (it would retrigger
 * itself). It only writes `netWorthSeries/*`.
 *
 * Cost per trade (see loadAffected): 1 + H + S + A + ΣA + R reads to load,
 * plus A for the series transactions; A writes at most. Logged as `reads`.
 */
export const onStockTraded = onDocumentUpdated({ document: "stocks/{id}", retry: false }, async (event) => {
  const before = event.data?.before.data() as Stock | undefined;
  const after = event.data?.after.data() as Stock | undefined;
  const mark = after?.lastTrade;
  if (!before || !after || !mark) return;
  if (before.lastTrade && before.lastTrade.at === mark.at && before.lastTrade.by === mark.by) return;

  const world = await loadAffected(after, mark.by);
  // Taken after the reads, so a later point never carries older data.
  const t = Date.now();
  const standings = computeStandings(world.players, world.stocks, world.holdings, world.openShorts, world.cfg.tradingFeePct);
  const windowMs = world.cfg.netWorthTickMinutes * 60_000;
  const results = await Promise.all(
    world.players.map((p) =>
      recordSeriesPoint(p.uid, mark.week, standings.get(p.uid)!.netWorth, t, windowMs).catch((err) => {
        logger.error("Net-worth point failed", { uid: p.uid, err });
        return { reads: 1, writes: 0 };
      }),
    ),
  );
  let reads = world.reads + results.reduce((a, r) => a + r.reads, 0);
  let writes = results.reduce((a, r) => a + r.writes, 0);

  // Margin (§4): re-evaluate affected players with open shorts or margin flags.
  // Same snapshot, so only 1 extra read (and ≤1 write, on a transition) each.
  const stockOf = new Map(world.stocks.map((s) => [s.id, s]));
  const marginUids = world.players
    .filter((p) => p.marginCall || p.marginWarnedAt !== undefined || world.openShorts.some((s) => s.ownerId === p.uid))
    .map((p) => p.uid);
  for (const uid of marginUids) {
    try {
      const event = await reevaluateMargin(uid, world.openShorts, stockOf, world.cfg, mark.week);
      reads += 1;
      if (event !== null) writes += 1;
    } catch (err) {
      logger.error("Margin re-evaluation failed", { uid, err });
    }
  }
  logger.info("onStockTraded", { stockId: after.id, affected: world.players.length, margin: marginUids.length, reads, writes });
});
