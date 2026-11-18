import { HttpsError } from "firebase-functions/v2/https";
import type { Transaction } from "firebase-admin/firestore";
import { assignTickers, validateTicker, type Player, type Post, type Stock } from "@fsm/shared";
import { gameCall, gameCtx, auditEntry, auditRef, db, optString, readConfig, readState, type Refs } from "./common";

/**
 * Store the effective ticker on every stock that doesn't have one yet (stocks
 * listed before tickers existed), so later name changes can't shift them.
 * Must run after all of the transaction's reads.
 */
export function backfillTickers(tx: Transaction, R: Refs, stocks: Stock[], effective: Map<string, string>): void {
  for (const s of stocks) {
    const t = effective.get(s.id);
    if (!s.ticker && t) tx.update(R.stock(s.id), { ticker: t });
  }
}

/**
 * Change your stock's ticker. Unique across all stocks in the same game (listed or not), 2–5
 * letters, with a cooldown so the feed doesn't fill with changes. Admins may
 * change anyone's (no cooldown, audit-logged).
 */
export const setTicker = gameCall(async (req) => {
  const { uid, serverId, R, admin, data } = await gameCtx(req, { allowAdmin: true });
  const target = optString(data, "uid", 128) ?? uid;
  const parsed = validateTicker(data.ticker);
  if (!parsed.ok) throw new HttpsError("invalid-argument", parsed.error);
  const ticker = parsed.ticker;
  const forSomeoneElse = target !== uid;
  if (forSomeoneElse && !admin) throw new HttpsError("permission-denied", "You can only change your own ticker.");
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const [playerSnap, stocksSnap] = await Promise.all([tx.get(R.player(target)), tx.get(R.col("stocks"))]);
    const cfg = await readConfig(tx, R);
    const { state } = await readState(tx, R, now);
    if (!playerSnap.exists) throw new HttpsError("not-found", forSomeoneElse ? "Player not found." : "You're not an approved player.");
    const player = playerSnap.data() as Player;
    if (!forSomeoneElse && !player.isActive) throw new HttpsError("permission-denied", "Your account is delisted.");
    const stocks = stocksSnap.docs.map((d) => d.data() as Stock);
    const stock = stocks.find((s) => s.id === target);
    if (!stock) throw new HttpsError("not-found", "Stock not found.");

    const effective = assignTickers(stocks);
    const previous = effective.get(stock.id)!;
    if (previous === ticker) {
      backfillTickers(tx, R, stocks, effective);
      return { ticker, changed: false };
    }
    const clash = [...effective].find(([id, t]) => id !== stock.id && t === ticker);
    if (clash) throw new HttpsError("already-exists", `$${ticker} is taken.`);

    const cooldownMs = cfg.tickerChangeCooldownHours * 3_600_000;
    if (!forSomeoneElse && stock.tickerChangedAt && now - stock.tickerChangedAt < cooldownMs) {
      const hours = Math.ceil((cooldownMs - (now - stock.tickerChangedAt)) / 3_600_000);
      throw new HttpsError("resource-exhausted", `You can change your ticker again in ${hours}h.`);
    }

    backfillTickers(tx, R, stocks.filter((s) => s.id !== stock.id), effective);
    tx.update(R.stock(stock.id), { ticker, tickerChangedAt: now });

    const postRef = R.col("posts").doc();
    const post: Post = {
      id: postRef.id,
      authorId: "system",
      authorName: "Market",
      taggedStockId: stock.id,
      taggedName: stock.displayName,
      text: `${stock.displayName} now trades as $${ticker} (was $${previous}).`,
      linkedTradeId: null,
      linkedTradeSummary: null,
      reactions: {},
      reactionCount: 0,
      system: true,
      week: state.currentWeek,
      createdAt: now,
    };
    tx.set(postRef, post);
    if (forSomeoneElse) tx.set(auditRef(), auditEntry(uid, "setTicker", target, { from: previous, to: ticker }, now, serverId));
    return { ticker, changed: true };
  });
});
