import { timingSafeEqual } from "node:crypto";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { mergeConfig, validateConfigPatch, type Holding, type Player, type Post, type Stock } from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, readState, refs, reqNumber, reqString, requireAdmin, requireAuth } from "./common";
import { closeWeek } from "./weeklyClose";

/**
 * Called by the client on sign-in. Records activity and silently reactivates
 * idle players (§5, open decision §11: silent reactivation, no back-pay).
 */
export const touch = onCall(async (req) => {
  const uid = requireAuth(req);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(refs.player(uid));
    if (!snap.exists) return { player: false, reactivated: false };
    const p = snap.data() as Player;
    if (!p.isActive) return { player: true, reactivated: false };
    tx.update(refs.player(uid), { lastActiveAt: now, isIdle: false });
    return { player: true, reactivated: p.isIdle };
  });
});

/** Admin: edit config/global. Unknown keys and out-of-range values are rejected. */
export const updateConfig = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const patch = asObject(asObject(req.data).patch);
  const errors = validateConfigPatch(patch);
  if (errors.length) throw new HttpsError("invalid-argument", errors.join("; "));
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(refs.config());
    const before = mergeConfig(snap.data());
    const after = mergeConfig({ ...before, ...(patch as object) });
    tx.set(refs.config(), after);
    const changed = Object.fromEntries(
      Object.keys(patch).map((k) => [k, { from: before[k as keyof typeof before], to: after[k as keyof typeof after] }]),
    );
    tx.set(auditRef(), auditEntry(adminId, "updateConfig", "config/global", { changed }, now));
    return after;
  });
});

/**
 * Admin: delist a player who wants out (§5). Holders are paid out at the
 * last price, the stock is removed from trading, and the account is deactivated.
 */
export const delistPlayer = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const uid = reqString(asObject(req.data), "uid", 128);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const { state } = await readState(tx, now);
    const [stockSnap, playerSnap, holdersSnap] = await Promise.all([
      tx.get(refs.stock(uid)),
      tx.get(refs.player(uid)),
      tx.get(db.collection("holdings").where("stockId", "==", uid)),
    ]);
    if (!stockSnap.exists || !playerSnap.exists) throw new HttpsError("not-found", "Player not found.");
    const stock = stockSnap.data() as Stock;
    if (!stock.listed) throw new HttpsError("failed-precondition", "Already delisted.");
    const holders = holdersSnap.docs.map((d) => d.data() as Holding);
    const holderSnaps = await Promise.all(holders.map((h) => tx.get(refs.player(h.uid))));

    const payouts: { uid: string; shares: number; cash: number }[] = [];
    holderSnaps.forEach((s, i) => {
      const h = holders[i];
      const cash = h.shares * stock.price;
      if (s.exists) {
        tx.update(s.ref, { cash: (s.data() as Player).cash + cash });
        payouts.push({ uid: h.uid, shares: h.shares, cash });
      }
      tx.delete(refs.holding(h.uid, uid));
    });

    tx.update(refs.stock(uid), { listed: false, delistedAt: now });
    tx.update(refs.player(uid), { isActive: false });

    const postRef = db.collection("posts").doc();
    const post: Post = {
      id: postRef.id,
      authorId: "system",
      authorName: "Market",
      taggedStockId: uid,
      taggedName: stock.displayName,
      text: `${stock.displayName} has been delisted. ${payouts.length} holder(s) were paid out at £${stock.price.toFixed(2)} per share.`,
      linkedTradeId: null,
      linkedTradeSummary: null,
      reactions: {},
      reactionCount: 0,
      system: true,
      week: state.currentWeek,
      createdAt: now,
    };
    tx.set(postRef, post);
    tx.set(auditRef(), auditEntry(adminId, "delistPlayer", uid, { displayName: stock.displayName, price: stock.price, payouts }, now));
    return { payouts };
  });
});

/** Admin button: manually trigger the weekly close. */
export const runWeeklyClose = onCall({ timeoutSeconds: 300 }, async (req) => {
  const adminId = await requireAdmin(req);
  const expectedWeek = reqNumber(asObject(req.data), "expectedWeek");
  return closeWeek({ trigger: "admin", actorId: adminId, expectedWeek });
});

const CRON_SECRET = defineSecret("CRON_SECRET");

/**
 * HTTPS endpoint pinged weekly by GitHub Actions. Requires
 * `Authorization: Bearer <CRON_SECRET>`. Skips if the last close was too recent.
 */
export const weeklyCloseCron = onRequest({ secrets: [CRON_SECRET], timeoutSeconds: 300 }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const header = req.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${CRON_SECRET.value()}`);
  const given = Buffer.from(header);
  if (CRON_SECRET.value().length < 16 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await closeWeek({ trigger: "cron", actorId: null });
    logger.info("weeklyCloseCron", result);
    res.json(result);
  } catch (err) {
    logger.error("weeklyCloseCron failed", err);
    res.status(500).json({ error: "Weekly close failed" });
  }
});
