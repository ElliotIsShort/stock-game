import { onCall, HttpsError } from "firebase-functions/v2/https";
import type { Transaction } from "firebase-admin/firestore";
import {
  CASH_EPSILON,
  SHARE_EPSILON,
  holdingAfterBuy,
  holdingAfterSell,
  priceTick,
  quoteBuy,
  quoteSell,
  type Holding,
  type Player,
  type Post,
  type Stock,
  type Trade,
  type TradeSide,
} from "@fsm/shared";
import { asObject, db, optString, readConfig, readState, refs, reqNumber, reqString, requireAuth } from "./common";
import { announceTrade, withHoldingStats } from "./marketEvents";

export function tradeSummary(t: Pick<Trade, "traderName" | "side" | "shares" | "stockName" | "cashAmount">): string {
  const verb = t.side === "buy" ? "bought" : "sold";
  return `${t.traderName} ${verb} ${t.shares.toFixed(2)} shares of ${t.stockName} (£${t.cashAmount.toFixed(2)})`;
}

/**
 * Execute a trade against a stock's pool. All AMM and fee math runs here;
 * the client only ever sends intent.
 *   buy:  amount = total cash to spend (fee included)
 *   sell: amount = shares to sell
 * Optional postText creates a post linked to this trade (§7).
 */
export const trade = onCall(async (req) => {
  const uid = requireAuth(req);
  const data = asObject(req.data);
  const stockId = reqString(data, "stockId", 128);
  const side = data.side as TradeSide;
  if (side !== "buy" && side !== "sell") throw new HttpsError("invalid-argument", "side must be buy or sell.");
  const amount = reqNumber(data, "amount");
  if (!(amount > 0)) throw new HttpsError("invalid-argument", "Amount must be positive.");
  const postText = optString(data, "postText", 5000);
  if (stockId === uid) throw new HttpsError("permission-denied", "You can't trade your own stock.");
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const cfg = await readConfig(tx);
    const { state, exists: stateExists } = await readState(tx, now);
    const [playerSnap, stockSnap, holdingSnap] = await Promise.all([
      tx.get(refs.player(uid)),
      tx.get(refs.stock(stockId)),
      tx.get(refs.holding(uid, stockId)),
    ]);
    if (!playerSnap.exists) throw new HttpsError("permission-denied", "You're not an approved player.");
    const player = playerSnap.data() as Player;
    if (!player.isActive) throw new HttpsError("permission-denied", "Your account is delisted.");
    if (!stockSnap.exists) throw new HttpsError("not-found", "Stock not found.");
    const stock = stockSnap.data() as Stock;
    if (!stock.listed) throw new HttpsError("failed-precondition", "That stock is delisted.");
    if (stock.ownerId === uid) throw new HttpsError("permission-denied", "You can't trade your own stock.");
    if (postText && postText.length > cfg.maxPostLength) throw new HttpsError("invalid-argument", `Post must be at most ${cfg.maxPostLength} characters.`);
    // Holdings from before cost tracking get it rebuilt from their trades (a read, so before any writes).
    const holding = await withHoldingStats(tx, holdingSnap.exists ? (holdingSnap.data() as Holding) : null);

    const heldShares = holding?.shares ?? 0;
    let newCash: number;
    let nextHolding: { shares: number; costBasis: number; holdingSince: number };
    let tradeData: Omit<Trade, "id" | "linkedPostId">;
    let pool: { cash: number; shares: number };

    if (side === "buy") {
      if (amount < 0.01) throw new HttpsError("invalid-argument", "Minimum buy is £0.01.");
      if (amount > player.cash + CASH_EPSILON) throw new HttpsError("failed-precondition", "Not enough cash.");
      const spend = Math.min(amount, player.cash);
      const q = quoteBuy(stock, spend, cfg.tradingFeePct);
      newCash = player.cash - spend;
      nextHolding = holdingAfterBuy(holding, q.shares, spend, now);
      pool = { cash: q.newPoolCash, shares: q.newPoolShares };
      tradeData = {
        traderId: uid,
        traderName: player.displayName,
        stockId,
        stockName: stock.displayName,
        side,
        cashAmount: spend,
        netCash: -spend,
        shares: q.shares,
        fee: q.fee,
        priceBefore: q.priceBefore,
        priceAfter: q.priceAfter,
        week: state.currentWeek,
        createdAt: now,
      };
    } else {
      if (amount > heldShares + SHARE_EPSILON) throw new HttpsError("failed-precondition", "You don't hold that many shares.");
      // Selling "all" may differ from the stored balance by float dust; clamp.
      const sellShares = Math.min(amount, heldShares);
      if (!holding || !(sellShares > 0)) throw new HttpsError("failed-precondition", "You don't hold any shares.");
      const q = quoteSell(stock, sellShares, cfg.tradingFeePct);
      newCash = player.cash + q.netCash;
      nextHolding = holdingAfterSell(holding, sellShares, now);
      pool = { cash: q.newPoolCash, shares: q.newPoolShares };
      tradeData = {
        traderId: uid,
        traderName: player.displayName,
        stockId,
        stockName: stock.displayName,
        side,
        cashAmount: q.grossCash,
        netCash: q.netCash,
        shares: sellShares,
        fee: q.fee,
        priceBefore: q.priceBefore,
        priceAfter: q.priceAfter,
        week: state.currentWeek,
        createdAt: now,
      };
    }

    const tick = priceTick(stock, tradeData.priceAfter, state.currentWeek);
    applyPool(tx, stock, pool.cash, pool.shares, tradeData.priceAfter, tick.patch);

    // Wallet + holding.
    tx.update(refs.player(uid), { cash: newCash, lastActiveAt: now, isIdle: false });
    if (nextHolding.shares <= SHARE_EPSILON) tx.delete(refs.holding(uid, stockId));
    else tx.set(refs.holding(uid, stockId), { uid, stockId, ...nextHolding, updatedAt: now });

    // Fee → prize pool.
    const nextState = { ...state, prizePool: state.prizePool + tradeData.fee, weekFees: state.weekFees + tradeData.fee };
    if (stateExists) tx.update(refs.state(), { prizePool: nextState.prizePool, weekFees: nextState.weekFees });
    else tx.set(refs.state(), nextState);

    const tradeRef = db.collection("trades").doc();
    let linkedPostId: string | null = null;
    if (postText) {
      const postRef = db.collection("posts").doc();
      linkedPostId = postRef.id;
      const post: Post = {
        id: postRef.id,
        authorId: uid,
        authorName: player.displayName,
        taggedStockId: stockId,
        taggedName: stock.displayName,
        text: postText,
        linkedTradeId: tradeRef.id,
        linkedTradeSummary: tradeSummary(tradeData),
        reactions: {},
        reactionCount: 0,
        system: false,
        week: state.currentWeek,
        createdAt: now,
      };
      tx.set(postRef, post);
    }
    const tradeDoc: Trade = { id: tradeRef.id, ...tradeData, linkedPostId, recentPrices: tick.recentPrices };
    tx.set(tradeRef, tradeDoc);

    announceTrade(tx, {
      kind: side,
      traderName: player.displayName,
      stock,
      cash: tradeData.cashAmount,
      shares: tradeData.shares,
      priceBefore: tradeData.priceBefore,
      priceAfter: tradeData.priceAfter,
      postText,
      tick,
    }, state, cfg, now);
    return tradeDoc;
  });
});

export function applyPool(tx: Transaction, stock: Stock, poolCash: number, poolShares: number, price: number, extra: Partial<Stock> = {}) {
  tx.update(refs.stock(stock.id), {
    poolCash,
    poolShares,
    k: poolCash * poolShares,
    price,
    weekHigh: Math.max(stock.weekHigh, price),
    weekLow: Math.min(stock.weekLow, price),
    weekTradeCount: stock.weekTradeCount + 1,
    ...extra,
  });
}
