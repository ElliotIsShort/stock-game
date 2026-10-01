import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
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
  holdingsByUid,
  readConfig,
  readState,
  readWorld,
  refs,
  reqString,
  requireAdmin,
} from "./common";

/** §4.3 step 1: a signed-in user asks to join. No funds until an admin approves. */
export const register = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const displayName = reqString(asObject(req.data), "displayName", 30).replace(/\s+/g, " ");
  if (displayName.length < 2) throw new HttpsError("invalid-argument", "Name must be at least 2 characters.");
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const [regSnap, playerSnap, clash] = await Promise.all([
      tx.get(refs.registration(uid)),
      tx.get(refs.player(uid)),
      tx.get(db.collection("registrations").where("displayNameLower", "==", displayName.toLowerCase())),
    ]);
    if (playerSnap.exists) throw new HttpsError("already-exists", "You're already a player.");
    const current = regSnap.data() as Registration | undefined;
    if (current?.status === "pending") throw new HttpsError("already-exists", "Your registration is already pending.");
    if (current?.status === "approved") throw new HttpsError("already-exists", "You're already approved.");
    const taken = clash.docs.some((d) => d.id !== uid && (d.data() as Registration).status !== "rejected");
    if (taken) throw new HttpsError("already-exists", "That name is taken.");
    const reg: Registration & { displayNameLower: string } = {
      uid,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      email: req.auth!.token.email ?? null,
      status: "pending",
      createdAt: now,
    };
    tx.set(refs.registration(uid), reg);
  });
  return { ok: true };
});

/**
 * §4.3: atomically create the player (with startingCash) and their listed
 * stock with a pool sized per §2.1.
 */
export const approvePlayer = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const uid = reqString(asObject(req.data), "uid", 128);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const regSnap = await tx.get(refs.registration(uid));
    if (!regSnap.exists) throw new HttpsError("not-found", "No registration for that user.");
    const reg = regSnap.data() as Registration;
    if (reg.status !== "pending") throw new HttpsError("failed-precondition", `Registration is ${reg.status}.`);
    const existing = await tx.get(refs.player(uid));
    if (existing.exists) throw new HttpsError("already-exists", "Player already exists.");

    const cfg = await readConfig(tx);
    const { state, exists: stateExists } = await readState(tx, now);
    const world = await readWorld(tx);

    const cash = startingCash(state.currentWeek, cfg);

    // Listing price: base price for the first stocks, else median of listed prices.
    const listed = world.stocks.filter((s) => s.listed);
    const price = listingPrice(listed.map((s) => s.price), cfg.baseStockPrice);

    // Average net worth of active, non-idle players, including the newcomer.
    const priceMap = new Map(listed.map((s) => [s.id, s.price]));
    const byUid = holdingsByUid(world.holdings);
    const worths = world.players
      .filter((p) => p.isActive && !p.isIdle)
      .map((p) => netWorth(p.cash, byUid.get(p.uid) ?? [], (id) => priceMap.get(id)));
    worths.push(cash);
    const avgNetWorth = mean(worths)!;

    const pool = listingPool(avgNetWorth, price, cfg.targetTradeSize, cfg.targetImpact);

    const player: Player = {
      uid,
      displayName: reg.displayName,
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
      displayName: reg.displayName,
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
    };

    tx.set(refs.player(uid), player);
    tx.set(refs.stock(uid), stock);
    tx.update(refs.registration(uid), { status: "approved", decidedAt: now, decidedBy: adminId });
    if (!stateExists) tx.set(refs.state(), state);

    const postRef = db.collection("posts").doc();
    const post: Post = {
      id: postRef.id,
      authorId: "system",
      authorName: "Market",
      taggedStockId: uid,
      taggedName: reg.displayName,
      text: `${reg.displayName} has listed at £${price.toFixed(2)}.`,
      linkedTradeId: null,
      linkedTradeSummary: null,
      reactions: {},
      reactionCount: 0,
      system: true,
      week: state.currentWeek,
      createdAt: now,
    };
    tx.set(postRef, post);
    tx.set(auditRef(), auditEntry(adminId, "approvePlayer", uid, { displayName: reg.displayName, startingCash: cash, listingPrice: price, poolCash: pool.poolCash }, now));

    return { uid, startingCash: cash, listingPrice: price, poolCash: pool.poolCash, poolShares: pool.poolShares };
  });
});

export const rejectPlayer = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const uid = reqString(asObject(req.data), "uid", 128);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const regSnap = await tx.get(refs.registration(uid));
    if (!regSnap.exists) throw new HttpsError("not-found", "No registration for that user.");
    if ((regSnap.data() as Registration).status !== "pending") throw new HttpsError("failed-precondition", "Registration is not pending.");
    tx.update(refs.registration(uid), { status: "rejected", decidedAt: now, decidedBy: adminId });
    tx.set(auditRef(), auditEntry(adminId, "rejectPlayer", uid, {}, now));
  });
  return { ok: true };
});
