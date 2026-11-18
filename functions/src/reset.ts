import { HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { advanceClosesAt, type Player } from "@fsm/shared";
import { gameCall, gameCtx, auditEntry, auditRef, db, globalRefs, initialState } from "./common";

/** The admin must send this exact string; the UI makes them type it. */
export const RESET_CONFIRMATION = "RESET";

/** Game data wiped by a reset. Players go first so trades/posts stop being accepted straight away. */
const WIPED_COLLECTIONS = [
  "players", "stocks", "holdings", "trades", "posts", "photos", "netWorthHistory", "netWorthSeries", "shorts", "weeklyReports",
  "alerts", "notifications", "discordOutbox", "discordState",
] as const;

/**
 * Admin: reset ONE game (the named server) back to day one. Other servers are untouched.
 *
 * Wipes every player, stock, holding, trade, post, photo and weekly report,
 * and restarts the game state at week 1 with an empty prize pool.
 *
 * Kept: sign-in accounts, admins, the server itself, its Discord webhook, config/global (your tuned settings) and the
 * audit log. Everyone who was an active player is put back to "pending", so
 * they don't have to re-register: an admin just re-approves them and they
 * start fresh as week-1 founders. Delisted players are marked "rejected" so
 * they can ask to rejoin if they want.
 *
 * Not a single transaction (it can touch thousands of docs), so avoid
 * running it while people are actively trading.
 */
export const resetGame = gameCall({ timeoutSeconds: 540, memory: "512MiB" }, async (req) => {
  const { uid: adminId, serverId, R, data } = await gameCtx(req, { admin: true });
  if (data.confirm !== RESET_CONFIRMATION) {
    throw new HttpsError("invalid-argument", `Type ${RESET_CONFIRMATION} to confirm.`);
  }
  const now = Date.now();

  // Keep the weekly close slot (day and time) the admin chose, moved on if it has passed.
  const oldState = (await R.state().get()).data();
  const oldClosesAt = oldState?.closesAt;
  const closesAt = typeof oldClosesAt === "number" ? (oldClosesAt > now ? oldClosesAt : advanceClosesAt(oldClosesAt, now)) : undefined;

  // Who was playing, so their registrations can be re-queued after the wipe.
  const playersSnap = await R.col("players").get();
  const wasActive = new Map(playersSnap.docs.map((d) => [d.id, (d.data() as Player).isActive]));

  const deleted: Record<string, number> = {};
  for (const name of WIPED_COLLECTIONS) {
    const ref = R.col(name);
    deleted[name] = (await ref.count().get()).data().count;
    await db.recursiveDelete(ref);
  }

  // Wiped players are no longer members of this game: drop it from their lookup cache.
  const writer = db.bulkWriter();
  for (const uid of wasActive.keys()) writer.set(globalRefs.user(uid), { serverIds: FieldValue.arrayRemove(serverId) }, { merge: true });
  // Re-queue registrations only for people who now belong to no game at all
  // (someone who is also in another game keeps their approval; add them back
  // here with "Add existing user").
  const regs = await db.collection("registrations").where("status", "==", "approved").get();
  let requeued = 0;
  let declined = 0;
  for (const d of regs.docs) {
    if (!wasActive.has(d.id)) continue;
    const others = ((await globalRefs.user(d.id).get()).data()?.serverIds as string[] | undefined) ?? [];
    if (others.some((id) => id !== serverId)) continue;
    if (wasActive.get(d.id) === false) {
      writer.update(d.ref, { status: "rejected", decidedAt: now, decidedBy: adminId });
      declined++;
    } else {
      writer.update(d.ref, { status: "pending", createdAt: now, decidedAt: null, decidedBy: null });
      requeued++;
    }
  }
  const freshState = { ...initialState(now), ...(closesAt !== undefined ? { closesAt } : {}) };
  writer.set(R.state(), freshState);
  writer.update(R.server(), { closesAt: freshState.closesAt });
  writer.set(auditRef(), auditEntry(adminId, "resetGame", null, { deleted, requeued, declined }, now, serverId));
  await writer.close();

  return { deleted, requeued, declined };
});
