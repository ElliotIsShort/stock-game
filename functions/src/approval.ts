import { HttpsError } from "firebase-functions/v2/https";
import {
  assignTickers,
  defaultTicker,
  listingMessage,
  listingPool,
  listingPrice,
  mean,
  netWorth,
  startingCash,
  type Player,
  type Post,
  type Registration,
  type Stock,
} from "@fsm/shared";
import {
  asObject,
  auditEntry,
  auditRef,
  db,
  gameCall,
  gameCtx,
  holdingsByUid,
  readConfig,
  readState,
  readWorld,
  refs,
  optString,
  reqString,
  requireAdmin,
  globalRefs,
  type Refs,
} from "./common";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { backfillTickers } from "./ticker";
import { enqueueDiscord } from "./discord";

/**
 * §4.3 step 1: a signed-in user asks to join. No funds until an admin approves.
 * Registration is global (one per account); display-name uniqueness is checked
 * later, at approval, inside the chosen server.
 */
export const register = gameCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const displayName = reqString(asObject(req.data), "displayName", 30).replace(/\s+/g, " ");
  if (displayName.length < 2) throw new HttpsError("invalid-argument", "Name must be at least 2 characters.");
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const regSnap = await tx.get(globalRefs.registration(uid));
    const current = regSnap.data() as Registration | undefined;
    if (current?.status === "pending") throw new HttpsError("already-exists", "Your registration is already pending.");
    if (current?.status === "approved") throw new HttpsError("already-exists", "You're already approved.");
    const reg: Registration = {
      uid,
      displayName,
      email: req.auth!.token.email ?? null,
      status: "pending",
      createdAt: now,
    };
    tx.set(globalRefs.registration(uid), reg);
  });
  return { ok: true };
});

/**
 * Put a user into a server as a new player, inside the caller's transaction:
 * the Player (catch-up `startingCash` from THIS server's week), a listed Stock
 * at this server's listing price with a pool sized from this server's average
 * net worth, a default ticker unique within the server, a system post and a
 * Discord listing message in this server, `users.serverIds`, and an audit
 * entry. Shared by `approvePlayer` and `addPlayerToServer`.
 *
 * Names and tickers only have to be unique within the server.
 */
async function placePlayer(
  tx: Transaction,
  R: Refs,
  a: { uid: string; displayName: string; adminId: string; action: string; now: number },
) {
  const { uid, displayName, adminId, now } = a;
  const existing = await tx.get(R.player(uid));
  if (existing.exists) throw new HttpsError("already-exists", "Player already exists in that server.");
  const cfg = await readConfig(tx, R);
  const { state, exists: stateExists } = await readState(tx, R, now);
  const world = await readWorld(tx, R);
  if (world.players.some((p) => p.displayName.toLowerCase() === displayName.toLowerCase())) {
    throw new HttpsError("already-exists", `The name "${displayName}" is already used in that server.`);
  }
  const cash = startingCash(state.currentWeek, cfg);
  // Listing price: base price for the first stocks, else median of this server's listed prices.
  const listed = world.stocks.filter((s) => s.listed);
  const price = listingPrice(listed.map((s) => s.price), cfg.baseStockPrice);
  // Average net worth of active, non-idle players in this server, including the newcomer.
  const priceMap = new Map(listed.map((s) => [s.id, s.price]));
  const byUid = holdingsByUid(world.holdings);
  const worths = world.players
    .filter((p) => p.isActive && !p.isIdle)
    .map((p) => netWorth(p.cash, byUid.get(p.uid) ?? [], (id) => priceMap.get(id)));
  worths.push(cash);
  const avgNetWorth = mean(worths)!;
  const pool = listingPool(avgNetWorth, price, cfg.targetTradeSize, cfg.targetImpact);
  // A default ticker from their name, unique in this server; they can change it from their stock page.
  const tickers = assignTickers(world.stocks);
  const ticker = defaultTicker(displayName, new Set(tickers.values()));
  const player: Player = {
    uid,
    displayName,
    cash,
    joinWeek: state.currentWeek,
    isActive: true,
    isIdle: false,
    lastActiveAt: now,
    createdAt: now,
    startingCash: cash,
    totalAllowances: 0,
    totalBonus: 0,
    netWorthWeekStart: cash,
  };
  const stock: Stock = {
    id: uid,
    ownerId: uid,
    displayName,
    price,
    poolCash: pool.poolCash,
    poolShares: pool.poolShares,
    k: pool.poolCash * pool.poolShares,
    listed: true,
    listPrice: price,
    listedAt: now,
    listedWeek: state.currentWeek,
    weekOpenPrice: price,
    weekHigh: price,
    weekLow: price,
    weekTradeCount: 0,
    ticker,
  };
  tx.set(R.player(uid), player);
  tx.set(R.stock(uid), stock);
  backfillTickers(tx, R, world.stocks, tickers);
  // Lookup cache for the client (membership itself is the player doc above).
  tx.set(globalRefs.user(uid), { serverIds: FieldValue.arrayUnion(R.serverId) }, { merge: true });
  // Average net worth also sets Discord's "big trade" threshold until the next close refreshes it.
  if (!stateExists) tx.set(R.state(), { ...state, avgNetWorth });
  else tx.update(R.state(), { avgNetWorth });
  enqueueDiscord(tx, R, "high", "listing", listingMessage(uid, displayName, ticker, price), now);
  const postRef = R.col("posts").doc();
  const post: Post = {
    id: postRef.id,
    authorId: "system",
    authorName: "Market",
    taggedStockId: uid,
    taggedName: displayName,
    text: `${displayName} has listed as $${ticker} at £${price.toFixed(2)}.`,
    linkedTradeId: null,
    linkedTradeSummary: null,
    reactions: {},
    reactionCount: 0,
    system: true,
    week: state.currentWeek,
    createdAt: now,
  };
  tx.set(postRef, post);
  tx.set(
    auditRef(),
    auditEntry(adminId, a.action, uid, { displayName, startingCash: cash, listingPrice: price, poolCash: pool.poolCash, ticker }, now, R.serverId),
  );
  return { uid, startingCash: cash, listingPrice: price, poolCash: pool.poolCash, poolShares: pool.poolShares };
}

/**
 * §4.3: the admin approves a pending registration AND chooses the server the
 * player is placed in. Atomically creates the player (with startingCash) and
 * their listed stock with a pool sized per §2.1 in that server.
 */
export const approvePlayer = gameCall(async (req) => {
  const { uid: adminId, R, data } = await gameCtx(req, { admin: true });
  const uid = reqString(data, "uid", 128);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const regSnap = await tx.get(globalRefs.registration(uid));
    if (!regSnap.exists) throw new HttpsError("not-found", "No registration for that user.");
    const reg = regSnap.data() as Registration;
    if (reg.status !== "pending") throw new HttpsError("failed-precondition", `Registration is ${reg.status}.`);
    const placed = await placePlayer(tx, R, { uid, displayName: reg.displayName, adminId, action: "approvePlayer", now });
    tx.update(globalRefs.registration(uid), { status: "approved", decidedAt: now, decidedBy: adminId });
    return placed;
  });
});

/**
 * Admin: add an already-approved user to another server (this is how the
 * owner joins server 2). They get a separate player, cash, stock and ticker
 * there; `displayName` defaults to their registered name and may differ per
 * server.
 */
export const addPlayerToServer = gameCall(async (req) => {
  const { uid: adminId, R, data } = await gameCtx(req, { admin: true });
  const uid = reqString(data, "uid", 128);
  const nameArg = optString(data, "displayName", 30);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const regSnap = await tx.get(globalRefs.registration(uid));
    if (!regSnap.exists) throw new HttpsError("not-found", "No registration for that user.");
    const reg = regSnap.data() as Registration;
    if (reg.status !== "approved") throw new HttpsError("failed-precondition", "Only an already-approved user can be added to another server. Approve pending sign-ups from the approvals list.");
    const displayName = (nameArg ?? reg.displayName).replace(/\s+/g, " ");
    if (displayName.length < 2) throw new HttpsError("invalid-argument", "Name must be at least 2 characters.");
    return placePlayer(tx, R, { uid, displayName, adminId, action: "addPlayerToServer", now });
  });
});

export const rejectPlayer = gameCall(async (req) => {
  const adminId = await requireAdmin(req);
  const uid = reqString(asObject(req.data), "uid", 128);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const regSnap = await tx.get(globalRefs.registration(uid));
    if (!regSnap.exists) throw new HttpsError("not-found", "No registration for that user.");
    if ((regSnap.data() as Registration).status !== "pending") throw new HttpsError("failed-precondition", "Registration is not pending.");
    tx.update(globalRefs.registration(uid), { status: "rejected", decidedAt: now, decidedBy: adminId });
    tx.set(auditRef(), auditEntry(adminId, "rejectPlayer", uid, {}, now));
  });
  return { ok: true };
});
