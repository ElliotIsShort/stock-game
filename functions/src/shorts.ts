import { onCall, HttpsError } from "firebase-functions/v2/https";
import type { Transaction } from "firebase-admin/firestore";
import {
  priceTick,
  quoteCloseShort,
  quoteOpenShort,
  shortExposure,
  shortableCapital,
  type Holding,
  type Player,
  type Post,
  type Short,
  type Stock,
} from "@fsm/shared";
import { applyBankruptcySettlement } from "./bankruptcy";
import { asObject, db, optString, readConfig, readState, refs, reqNumber, reqString, requireAuth } from "./common";
import { announceTrade } from "./marketEvents";
import { applyPool } from "./trading";

function shortSummary(s: Pick<Short, "ownerName" | "shares" | "stockName">, action: "opened" | "closed"): string {
  return `${s.ownerName} ${action} a short on ${s.shares.toFixed(2)} shares of ${s.stockName}`;
}

/**
 * Open a synthetic short: sell `shares` you don't own into the pool, receive
 * cash now, and owe a buy-back later. Capped so total open-short value stays
 * within maxShortExposurePct of your capital (cash + holdings value).
 */
export const openShort = onCall(async (req) => {
  const uid = requireAuth(req);
  const data = asObject(req.data);
  const stockId = reqString(data, "stockId", 128);
  const shares = reqNumber(data, "shares");
  const postText = optString(data, "postText", 5000);
  if (!(shares > 0)) throw new HttpsError("invalid-argument", "Shares must be positive.");
  if (stockId === uid) throw new HttpsError("permission-denied", "You can't short your own stock.");
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const cfg = await readConfig(tx);
    const { state, exists: stateExists } = await readState(tx, now);
    const [playerSnap, stockSnap, openShortsSnap, holdingsSnap, stocksSnap] = await Promise.all([
      tx.get(refs.player(uid)),
      tx.get(refs.stock(stockId)),
      tx.get(db.collection("shorts").where("ownerId", "==", uid).where("status", "==", "open")),
      tx.get(db.collection("holdings").where("uid", "==", uid)),
      tx.get(db.collection("stocks")),
    ]);
    if (!playerSnap.exists) throw new HttpsError("permission-denied", "You're not an approved player.");
    const player = playerSnap.data() as Player;
    if (!player.isActive) throw new HttpsError("permission-denied", "Your account is deactivated.");
    if (!stockSnap.exists) throw new HttpsError("not-found", "Stock not found.");
    const stock = stockSnap.data() as Stock;
    if (!stock.listed) throw new HttpsError("failed-precondition", "That stock is delisted.");
    if (stock.ownerId === uid) throw new HttpsError("permission-denied", "You can't short your own stock.");
    if (postText && postText.length > cfg.maxPostLength) throw new HttpsError("invalid-argument", `Post must be at most ${cfg.maxPostLength} characters.`);

    // Exposure cap: existing open shorts + this one must stay within the fraction of capital.
    const priceOf = (id: string) => (stocksSnap.docs.find((d) => d.id === id)?.data() as Stock | undefined)?.price;
    const holdings = holdingsSnap.docs.map((d) => d.data() as Holding);
    const holdingsValue = holdings.reduce((sum, h) => sum + h.shares * (priceOf(h.stockId) ?? 0), 0);
    const capital = shortableCapital(player.cash, holdingsValue);
    const existingExposure = openShortsSnap.docs.reduce((sum, d) => {
      const s = d.data() as Short;
      return sum + shortExposure(s.shares, priceOf(s.stockId) ?? 0);
    }, 0);
    const q = quoteOpenShort(stock, shares, cfg.tradingFeePct);
    const newExposure = existingExposure + shortExposure(shares, q.priceAfter);
    if (newExposure > capital * cfg.maxShortExposurePct + 1e-6) {
      throw new HttpsError("failed-precondition", `That would exceed your short limit (${(cfg.maxShortExposurePct * 100).toFixed(0)}% of your £${capital.toFixed(2)} capital).`);
    }

    const tick = priceTick(stock, q.priceAfter, state.currentWeek);
    applyPool(tx, stock, q.newPoolCash, q.newPoolShares, q.priceAfter, tick.patch);
    tx.update(refs.player(uid), { cash: player.cash + q.proceeds, lastActiveAt: now, isIdle: false });
    const nextState = { prizePool: state.prizePool + q.fee, weekFees: state.weekFees + q.fee };
    if (stateExists) tx.update(refs.state(), nextState);
    else tx.set(refs.state(), { ...state, ...nextState });

    const shortRef = db.collection("shorts").doc();
    const short: Short = {
      id: shortRef.id,
      ownerId: uid,
      ownerName: player.displayName,
      stockId,
      stockName: stock.displayName,
      shares,
      status: "open",
      openPrice: q.priceAfter,
      openProceeds: q.proceeds,
      openedAt: now,
      openWeek: state.currentWeek,
      borrowFeesPaid: 0,
    };
    tx.set(shortRef, short);
    recordTrade(tx, { player, stock, side: "sell", shares, cashAmount: q.proceeds, netCash: q.proceeds, fee: q.fee, priceBefore: q.priceBefore, priceAfter: q.priceAfter, week: state.currentWeek, now, kind: "openShort", postText, recentPrices: tick.recentPrices });
    // A short's size for Discord is the value sold at the pre-trade price.
    announceTrade(tx, { kind: "openShort", traderName: player.displayName, stock, cash: shares * q.priceBefore, shares, priceBefore: q.priceBefore, priceAfter: q.priceAfter, postText, tick }, state, cfg, now);
    return short;
  });
});

/**
 * Close an open short: buy the shares back from the pool. If the buy-back costs
 * more than you can pay, the bankruptcy mechanism settles it. Players may close
 * at any time, in profit or at a loss.
 */
export const closeShort = onCall(async (req) => {
  const uid = requireAuth(req);
  const data = asObject(req.data);
  const shortId = reqString(data, "shortId", 128);
  const postText = optString(data, "postText", 5000);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const cfg = await readConfig(tx);
    const { state, exists: stateExists } = await readState(tx, now);
    const shortSnap = await tx.get(refs.short(shortId));
    if (!shortSnap.exists) throw new HttpsError("not-found", "Short not found.");
    const short = shortSnap.data() as Short;
    if (short.ownerId !== uid) throw new HttpsError("permission-denied", "That isn't your short.");
    if (short.status !== "open") throw new HttpsError("failed-precondition", "That short is already closed.");

    const [playerSnap, stockSnap] = await Promise.all([tx.get(refs.player(uid)), tx.get(refs.stock(short.stockId))]);
    if (!playerSnap.exists) throw new HttpsError("permission-denied", "You're not an approved player.");
    const player = playerSnap.data() as Player;
    if (!stockSnap.exists) throw new HttpsError("not-found", "Stock not found.");
    const stock = stockSnap.data() as Stock;
    if (postText && postText.length > cfg.maxPostLength) throw new HttpsError("invalid-argument", `Post must be at most ${cfg.maxPostLength} characters.`);

    const q = quoteCloseShort(stock, short.shares, cfg.tradingFeePct);
    const realisedPnl = short.openProceeds - q.cost - short.borrowFeesPaid;

    const tick = priceTick(stock, q.priceAfter, state.currentWeek);
    applyPool(tx, stock, q.newPoolCash, q.newPoolShares, q.priceAfter, tick.patch);
    const nextState = { prizePool: state.prizePool + q.fee, weekFees: state.weekFees + q.fee };
    if (stateExists) tx.update(refs.state(), nextState);
    else tx.set(refs.state(), { ...state, ...nextState });

    tx.update(refs.short(shortId), {
      status: "closed",
      closePrice: q.priceAfter,
      closeCost: q.cost,
      realisedPnl,
      closedAt: now,
      closeWeek: state.currentWeek,
    });
    recordTrade(tx, { player, stock, side: "buy", shares: short.shares, cashAmount: q.cost, netCash: -q.cost, fee: q.fee, priceBefore: q.priceBefore, priceAfter: q.priceAfter, week: state.currentWeek, now, kind: "closeShort", postText, recentPrices: tick.recentPrices });
    announceTrade(tx, { kind: "closeShort", traderName: player.displayName, stock, cash: q.cost, shares: short.shares, priceBefore: q.priceBefore, priceAfter: q.priceAfter, postText, tick }, state, cfg, now);

    if (q.cost > player.cash + 1e-6) {
      // Can't afford the buy-back: liquidate holdings and, if still short, go bankrupt.
      const holdingsSnap = await db.collection("holdings").where("uid", "==", uid).get();
      const debtorHoldings = holdingsSnap.docs.map((d) => d.data() as Holding);
      const stocksSnap = await db.collection("stocks").get();
      const stockOf = new Map(stocksSnap.docs.map((d) => [d.id, d.data() as Stock]));
      // The pool change from this close is already staged above; reflect it for liquidation pricing.
      stockOf.set(stock.id, { ...stock, ...tick.patch, poolCash: q.newPoolCash, poolShares: q.newPoolShares, price: q.priceAfter });
      applyBankruptcySettlement(tx, player, debtorHoldings, stockOf, q.cost, [], cfg.tradingFeePct, now, state.currentWeek);
    } else {
      tx.update(refs.player(uid), { cash: player.cash - q.cost, lastActiveAt: now, isIdle: false });
    }
    return { ...short, status: "closed", closePrice: q.priceAfter, closeCost: q.cost, realisedPnl, closedAt: now };
  });
});

/** Record a short open/close in the trades feed, with an optional linked post. */
function recordTrade(
  tx: Transaction,
  a: {
    player: Player;
    stock: Stock;
    side: "buy" | "sell";
    shares: number;
    cashAmount: number;
    netCash: number;
    fee: number;
    priceBefore: number;
    priceAfter: number;
    week: number;
    now: number;
    kind: "openShort" | "closeShort";
    postText: string | null;
    recentPrices: number[];
  },
) {
  const tradeRef = db.collection("trades").doc();
  let linkedPostId: string | null = null;
  const summary = shortSummary({ ownerName: a.player.displayName, shares: a.shares, stockName: a.stock.displayName }, a.kind === "openShort" ? "opened" : "closed");
  if (a.postText) {
    const postRef = db.collection("posts").doc();
    linkedPostId = postRef.id;
    const post: Post = {
      id: postRef.id,
      authorId: a.player.uid,
      authorName: a.player.displayName,
      taggedStockId: a.stock.id,
      taggedName: a.stock.displayName,
      text: a.postText,
      linkedTradeId: tradeRef.id,
      linkedTradeSummary: summary,
      reactions: {},
      reactionCount: 0,
      system: false,
      week: a.week,
      createdAt: a.now,
    };
    tx.set(postRef, post);
  }
  tx.set(tradeRef, {
    id: tradeRef.id,
    traderId: a.player.uid,
    traderName: a.player.displayName,
    stockId: a.stock.id,
    stockName: a.stock.displayName,
    side: a.side,
    kind: a.kind,
    cashAmount: a.cashAmount,
    netCash: a.netCash,
    shares: a.shares,
    fee: a.fee,
    priceBefore: a.priceBefore,
    priceAfter: a.priceAfter,
    week: a.week,
    createdAt: a.now,
    linkedPostId,
    recentPrices: a.recentPrices,
  });
}
