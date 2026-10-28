import type { Transaction } from "firebase-admin/firestore";
import {
  bigTradeMessage,
  defaultTicker,
  positionFromTrades,
  priceTick,
  recordMessage,
  type GameConfig,
  type GameState,
  type Holding,
  type Stock,
  type Trade,
  type TradeKind,
} from "@fsm/shared";
import { db } from "./common";
import { enqueueDiscord, isBigTrade } from "./discord";

/** Stored ticker, or the default the market would assign (legacy stocks, until backfilled). */
export function tickerFor(stock: Pick<Stock, "ticker" | "displayName">): string {
  return stock.ticker ?? defaultTicker(stock.displayName, new Set());
}

/**
 * Discord side effects of one price-moving trade: a "big trade" post, and
 * all-time high/low posts. Call with the result of `priceTick`.
 */
export function announceTrade(
  tx: Transaction,
  a: {
    kind: TradeKind;
    traderName: string;
    stock: Stock;
    cash: number;
    shares: number;
    priceBefore: number;
    priceAfter: number;
    postText?: string | null;
    tick: ReturnType<typeof priceTick>;
  },
  state: GameState,
  cfg: GameConfig,
  now: number,
): void {
  const ticker = tickerFor(a.stock);
  if (isBigTrade(a.cash, state, cfg)) {
    enqueueDiscord(tx, "normal", "bigTrade", bigTradeMessage({
      kind: a.kind,
      traderName: a.traderName,
      ownerId: a.stock.ownerId,
      stockName: a.stock.displayName,
      ticker,
      cash: a.cash,
      shares: a.shares,
      priceBefore: a.priceBefore,
      priceAfter: a.priceAfter,
      postText: a.postText,
    }), now);
  }
  if (a.tick.announceHigh) enqueueDiscord(tx, "normal", "allTimeHigh", recordMessage(a.stock.ownerId, ticker, "high", a.priceAfter), now);
  if (a.tick.announceLow) enqueueDiscord(tx, "normal", "allTimeLow", recordMessage(a.stock.ownerId, ticker, "low", a.priceAfter), now);
}

/**
 * Cost basis and holding run for a holding from before those fields existed,
 * rebuilt from the player's trades in that stock. A read: call it before any
 * of the transaction's writes.
 */
export async function legacyHoldingStats(tx: Transaction, uid: string, stockId: string): Promise<{ costBasis: number; holdingSince: number }> {
  const snap = await tx.get(db.collection("trades").where("traderId", "==", uid).where("stockId", "==", stockId));
  const pos = positionFromTrades(snap.docs.map((d) => d.data() as Trade), 0);
  return { costBasis: pos.costBasis, holdingSince: pos.holdingSince ?? 0 };
}

/** Fill in costBasis/holdingSince on a holding that lacks them (see legacyHoldingStats). */
export async function withHoldingStats(tx: Transaction, h: Holding | null): Promise<Holding | null> {
  if (!h || (h.costBasis != null && h.holdingSince != null)) return h;
  return { ...h, ...(await legacyHoldingStats(tx, h.uid, h.stockId)) };
}
