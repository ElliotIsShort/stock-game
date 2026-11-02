import { logger } from "firebase-functions";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import {
  formatCloseTime,
  holdingAfterSell,
  liquidationMessage,
  liquidationSoldText,
  marginCallMessage,
  marginClearedMessage,
  marginStatus,
  marginWarnMessage,
  nextMarginFlags,
  planLiquidation,
  priceTick,
  quoteCloseShort,
  type AppNotification,
  type GameConfig,
  type Holding,
  type MarginEvent,
  type MarginFlags,
  type MarginStatus,
  type Player,
  type Pool,
  type Post,
  type Short,
  type Stock,
  type StockTradeMark,
  type Trade,
} from "@fsm/shared";
import { applyBankruptcySettlement } from "./bankruptcy";
import { auditEntry, auditRef, db, readConfig, readState, refs } from "./common";
import { enqueueDiscord } from "./discord";
import { withHoldingStats } from "./marketEvents";

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A listed stock's pool, or undefined (a delisted stock can't be traded). */
export function poolFrom(stockOf: Map<string, Stock>): (id: string) => Pool | undefined {
  return (id) => {
    const s = stockOf.get(id);
    return s && s.listed ? s : undefined;
  };
}

/** The player-doc fields for a set of margin flags (absent flags are deleted). */
export function marginPatch(flags: MarginFlags): Record<string, unknown> {
  return {
    marginWarnedAt: flags.marginWarnedAt ?? FieldValue.delete(),
    marginCall: flags.marginCall ?? FieldValue.delete(),
  };
}

function systemPost(tx: Transaction, text: string, week: number, now: number, taggedStock: Pick<Stock, "id" | "displayName"> | null = null): void {
  const ref = db.collection("posts").doc();
  const post: Post = {
    id: ref.id,
    authorId: "system",
    authorName: "Market",
    taggedStockId: taggedStock?.id ?? null,
    taggedName: taggedStock?.displayName ?? null,
    text,
    linkedTradeId: null,
    linkedTradeSummary: null,
    reactions: {},
    reactionCount: 0,
    system: true,
    week,
    createdAt: now,
  };
  tx.set(ref, post);
}

function notify(tx: Transaction, uid: string, title: string, body: string, now: number): void {
  const ref = db.collection("notifications").doc();
  const note: AppNotification = { id: ref.id, uid, kind: "margin", title, body, stockId: null, link: "/portfolio/#margin", createdAt: now, read: false };
  tx.set(ref, note);
}

/** Tell the player (and, for calls and clears, the market) about a margin transition. */
export function announceMargin(tx: Transaction, player: Pick<Player, "uid" | "displayName">, event: MarginEvent, flags: MarginFlags, status: MarginStatus, week: number, now: number): void {
  if (event === "warned") {
    notify(tx, player.uid, "⚠️ Margin warning", `Covering your shorts would cost ${gbp(status.coverCost)}, ${Math.round((status.coverCost / Math.max(status.cash, 0.01)) * 100)}% of your ${gbp(status.cash)} cash. Above 100% you'll be margin called.`, now);
    enqueueDiscord(tx, "normal", "marginWarn", marginWarnMessage(player.uid, status.coverCost, status.cash), now);
  } else if (event === "called" && flags.marginCall) {
    const when = formatCloseTime(flags.marginCall.deadline);
    notify(tx, player.uid, "🚨 Margin call", `Your shorts cost more to cover than your cash. Raise ${gbp(flags.marginCall.shortfall)} by ${when} (UK time) by selling holdings or covering, or holdings will be force-sold.`, now);
    systemPost(tx, `${player.displayName} has been margin called: they must raise ${gbp(flags.marginCall.shortfall)} by ${when} (UK time).`, week, now);
    enqueueDiscord(tx, "high", "marginCall", marginCallMessage(player.uid, player.displayName, flags.marginCall.shortfall, when), now);
  } else if (event === "cleared") {
    notify(tx, player.uid, "✅ Margin call cleared", "You can cover your shorts again. Nothing will be force-sold.", now);
    systemPost(tx, `${player.displayName} cleared their margin call.`, week, now);
    enqueueDiscord(tx, "normal", "marginCleared", marginClearedMessage(player.uid, player.displayName), now);
  }
}

/**
 * Re-evaluate one player's margin after a trade or price move, in its own
 * transaction (fresh cash and flags; 1 read, ≤1 player write). Shorts and
 * pools come from the caller's snapshot.
 */
export async function reevaluateMargin(uid: string, openShorts: Short[], stockOf: Map<string, Stock>, cfg: GameConfig, week: number): Promise<MarginEvent> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(refs.player(uid));
    const p = snap.data();
    if (!p) return null;
    const mine = openShorts.filter((s) => s.ownerId === uid && s.status === "open");
    if (mine.length === 0 && !p.marginCall && p.marginWarnedAt === undefined) return null;
    const now = Date.now();
    const status = marginStatus(p.cash, mine, poolFrom(stockOf), cfg);
    const next = nextMarginFlags(p, status, now);
    if (!next.changed) return null;
    tx.update(refs.player(uid), marginPatch(next.flags));
    announceMargin(tx, p, next.event, next.flags, status, week, now);
    return next.event;
  });
}

// ---------- Forced liquidation ----------

/**
 * Pool changes for several trades in one transaction, written once per stock
 * at the end (a document is written at most once per transaction).
 */
export class PoolLedger {
  private touched = new Map<string, { prices: number[]; trades: number }>();
  constructor(private stockOf: Map<string, Stock>) {}

  pool(id: string): Pool | undefined {
    const s = this.stockOf.get(id);
    return s && s.listed ? s : undefined;
  }

  stocks(): Map<string, Stock> {
    return this.stockOf;
  }

  apply(id: string, poolCash: number, poolShares: number, price: number): void {
    const s = this.stockOf.get(id)!;
    this.stockOf.set(id, { ...s, poolCash, poolShares, k: poolCash * poolShares, price });
    const t = this.touched.get(id) ?? { prices: [], trades: 0 };
    t.prices.push(price);
    t.trades++;
    this.touched.set(id, t);
  }

  /** Write every touched stock once. Forced trades keep records honest but don't announce them. */
  flush(tx: Transaction, original: Map<string, Stock>, mark: StockTradeMark): void {
    for (const [id, t] of this.touched) {
      const before = original.get(id)!;
      const s = this.stockOf.get(id)!;
      const hi = Math.max(...t.prices);
      const lo = Math.min(...t.prices);
      tx.update(refs.stock(id), {
        poolCash: s.poolCash,
        poolShares: s.poolShares,
        k: s.k,
        price: s.price,
        weekHigh: Math.max(before.weekHigh, hi),
        weekLow: Math.min(before.weekLow, lo),
        weekTradeCount: before.weekTradeCount + t.trades,
        allTimeHigh: priceTick(before, hi, mark.week).patch.allTimeHigh,
        allTimeLow: priceTick(before, lo, mark.week).patch.allTimeLow,
        lastTrade: mark,
      });
    }
  }
}

export type LiquidationResult =
  | { liquidated: true; uid: string; bankrupt: boolean; sold: { stockName: string; shares: number; cash: number }[]; raised: number; covered: string[] }
  | { liquidated: false; uid: string; reason: string };

function tradeDoc(a: Omit<Trade, "id" | "linkedPostId">): Trade {
  const ref = db.collection("trades").doc();
  return { id: ref.id, linkedPostId: null, ...a };
}

/**
 * Last resort after a missed margin-call deadline. One transaction (config and
 * state read first): sell holdings largest-value first, only until cash covers
 * the shorts (`planLiquidation`, same quotes and fees as a normal sell), then
 * buy every short back. The rest of the portfolio is left alone. If selling
 * everything still isn't enough, the shorts are bought back and the debt is
 * settled by the bankruptcy rule (`settleDebt`). Either way it's loud: forced
 * trades are `kind: "liquidation"` (FORCED SALE in the feed), plus a feed post,
 * a notification, a high-priority Discord post, an audit entry and a section
 * in the weekly report.
 */
export async function forceLiquidate(uid: string, now: number): Promise<LiquidationResult> {
  return db.runTransaction(async (tx): Promise<LiquidationResult> => {
    const cfg = await readConfig(tx);
    const { state, exists: stateExists } = await readState(tx, now);
    const [playerSnap, shortsSnap, holdingsSnap] = await Promise.all([
      tx.get(refs.player(uid)),
      tx.get(db.collection("shorts").where("ownerId", "==", uid).where("status", "==", "open")),
      tx.get(db.collection("holdings").where("uid", "==", uid)),
    ]);
    const player = playerSnap.data();
    if (!player) return { liquidated: false, uid, reason: "No such player." };
    if (!player.marginCall || player.marginCall.deadline > now) return { liquidated: false, uid, reason: "No margin call past its deadline." };
    const shorts = shortsSnap.docs.map((d) => d.data() as Short);
    const rawHoldings = holdingsSnap.docs.map((d) => d.data() as Holding);
    const ids = [...new Set([...shorts.map((s) => s.stockId), ...rawHoldings.map((h) => h.stockId)])];
    const stockSnaps = await Promise.all(ids.map((id) => tx.get(refs.stock(id))));
    const original = new Map(stockSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as Stock]));
    // Legacy holdings get their cost basis rebuilt (reads) before any writes.
    const holdings = (await Promise.all(rawHoldings.map((h) => withHoldingStats(tx, h)))) as Holding[];
    const week = state.currentWeek;

    const status = marginStatus(player.cash, shorts, poolFrom(original), cfg);
    if (status.level !== "call") {
      // Resolved at the last moment (e.g. a price move the trigger hadn't processed yet).
      const next = nextMarginFlags(player, status, now);
      tx.update(refs.player(uid), marginPatch(next.flags));
      announceMargin(tx, player, next.event, next.flags, status, week, now);
      return { liquidated: false, uid, reason: "The margin call was already covered." };
    }

    const fee = cfg.tradingFeePct;
    const ledger = new PoolLedger(new Map(original));
    const mark: StockTradeMark = { by: uid, at: now, week };
    const nameOf = (id: string) => original.get(id)?.displayName ?? id;
    const base = { traderId: uid, traderName: player.displayName, week, createdAt: now };
    const trades: Trade[] = [];
    const sold: { stockName: string; shares: number; cash: number }[] = [];
    let fees = 0;
    let bankrupt = false;

    const coverAll = (): number => {
      // Buy every short back from the (updated) pools; returns the total cost.
      let total = 0;
      for (const s of shorts) {
        const stock = ledger.stocks().get(s.stockId);
        const pool = ledger.pool(s.stockId);
        let cost: number;
        let q: ReturnType<typeof quoteCloseShort> | null = null;
        try {
          if (!pool) throw new Error("No pool");
          q = quoteCloseShort(pool, s.shares, fee);
          cost = q.cost;
        } catch {
          // A pool too shallow to buy back from (or a delisted stock): written off at the last price plus the fee, without moving the pool.
          cost = s.shares * (stock?.price ?? s.openPrice) * (1 + fee);
        }
        const priceBefore = stock?.price ?? s.openPrice;
        if (q) {
          ledger.apply(s.stockId, q.newPoolCash, q.newPoolShares, q.priceAfter);
          fees += q.fee;
        }
        total += cost;
        const priceAfter = q?.priceAfter ?? priceBefore;
        tx.update(refs.short(s.id), {
          status: "closed",
          closePrice: priceAfter,
          closeCost: cost,
          realisedPnl: s.openProceeds - cost - s.borrowFeesPaid,
          closedAt: now,
          closeWeek: week,
        });
        trades.push(tradeDoc({ ...base, stockId: s.stockId, stockName: s.stockName, side: "buy", kind: "closeShort", forced: true, cashAmount: cost, netCash: -cost, shares: s.shares, fee: q?.fee ?? cost - cost / (1 + fee), priceBefore, priceAfter }));
      }
      return total;
    };

    const plan = planLiquidation(player.cash, holdings, shorts, poolFrom(original), fee);
    let raised = 0;
    if (plan.solvent) {
      let cash = player.cash;
      for (const sale of plan.sales) {
        const h = holdings.find((x) => x.stockId === sale.stockId)!;
        ledger.apply(sale.stockId, sale.newPoolCash, sale.newPoolShares, sale.priceAfter);
        if (sale.all) tx.delete(refs.holding(uid, sale.stockId));
        else tx.set(refs.holding(uid, sale.stockId), { uid, stockId: sale.stockId, ...holdingAfterSell(h, sale.shares, now), updatedAt: now });
        fees += sale.fee;
        cash += sale.netCash;
        raised += sale.netCash;
        sold.push({ stockName: nameOf(sale.stockId), shares: sale.shares, cash: sale.netCash });
        trades.push(tradeDoc({ ...base, stockId: sale.stockId, stockName: nameOf(sale.stockId), side: "sell", kind: "liquidation", cashAmount: sale.grossCash, netCash: sale.netCash, shares: sale.shares, fee: sale.fee, priceBefore: sale.priceBefore, priceAfter: sale.priceAfter }));
      }
      cash -= coverAll();
      tx.update(refs.player(uid), { cash: Math.max(0, cash), ...marginPatch({}) });
    } else {
      // Even selling everything can't cover it: buy the shorts back, then settle the debt (bankruptcy rule).
      const debt = coverAll();
      const result = applyBankruptcySettlement(tx, player, holdings, ledger, debt, [], fee, now, week, marginPatch({}));
      bankrupt = result.bankrupt;
      for (const sale of result.sales) {
        fees += sale.fee;
        raised += sale.cash;
        sold.push({ stockName: nameOf(sale.stockId), shares: sale.shares, cash: sale.cash });
        trades.push(tradeDoc({ ...base, stockId: sale.stockId, stockName: nameOf(sale.stockId), side: "sell", kind: "liquidation", cashAmount: sale.grossCash, netCash: sale.cash, shares: sale.shares, fee: sale.fee, priceBefore: sale.priceBefore, priceAfter: sale.priceAfter }));
      }
    }

    ledger.flush(tx, original, mark);
    for (const t of trades) tx.set(db.collection("trades").doc(t.id), t);
    const nextState = { prizePool: state.prizePool + fees, weekFees: state.weekFees + fees };
    if (stateExists) tx.update(refs.state(), nextState);
    else tx.set(refs.state(), { ...state, ...nextState });

    const covered = [...new Set(shorts.map((s) => s.stockName))];
    const soldText = liquidationSoldText(sold);
    const coveredText = covered.length === 1 ? `a short on ${covered[0]}` : `shorts on ${covered.join(", ")}`;
    const tail = bankrupt ? " It wasn't enough: they're bankrupt until the next weekly close." : "";
    systemPost(tx, `${player.displayName} was force-liquidated to cover ${coveredText}: sold ${soldText} for ${gbp(raised)}.${tail}`, week, now);
    notify(tx, uid, "💥 Forced sale", `Your margin call deadline passed. To cover ${coveredText} the market sold ${soldText} for ${gbp(raised)}.${bankrupt ? " It wasn't enough, so you're bankrupt until the next weekly close." : " The rest of your portfolio is untouched."}`, now);
    enqueueDiscord(tx, "high", "liquidation", liquidationMessage(uid, player.displayName, covered, soldText, raised, bankrupt), now);
    tx.set(auditRef(), auditEntry("system", "forcedLiquidation", uid, { marginCall: player.marginCall, coverCost: status.coverCost, cash: player.cash, sold, raised, covered, bankrupt }, now));
    return { liquidated: true, uid, bankrupt, sold, raised, covered };
  });
}

/**
 * Players whose margin call deadline has passed (one cheap query: a single
 * read when there are none), liquidated one transaction each.
 */
export async function liquidateDueMarginCalls(now: number): Promise<LiquidationResult[]> {
  const due = await db.collection("players").where("marginCall.deadline", "<=", now).get();
  const out: LiquidationResult[] = [];
  for (const d of due.docs) {
    try {
      const res = await forceLiquidate(d.id, now);
      logger.info("Forced liquidation", res);
      out.push(res);
    } catch (err) {
      logger.error("Forced liquidation failed", { uid: d.id, err });
    }
  }
  return out;
}
