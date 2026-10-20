import { onCall, HttpsError } from "firebase-functions/v2/https";
import type { Player } from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, initialState, refs, requireAdmin } from "./common";

/** The admin must send this exact string; the UI makes them type it. */
export const RESET_CONFIRMATION = "RESET";

/** Game data wiped by a reset. Players go first so trades/posts stop being accepted straight away. */
const WIPED_COLLECTIONS = ["players", "stocks", "holdings", "trades", "posts", "photos", "netWorthHistory", "shorts", "weeklyReports"] as const;

/**
 * Admin: reset the market back to day one.
 *
 * Wipes every player, stock, holding, trade, post, photo and weekly report,
 * and restarts the game state at week 1 with an empty prize pool.
 *
 * Kept: sign-in accounts, admins, config/global (your tuned settings) and the
 * audit log. Everyone who was an active player is put back to "pending", so
 * they don't have to re-register: an admin just re-approves them and they
 * start fresh as week-1 founders. Delisted players are marked "rejected" so
 * they can ask to rejoin if they want.
 *
 * Not a single transaction (it can touch thousands of docs), so avoid
 * running it while people are actively trading.
 */
export const resetGame = onCall({ timeoutSeconds: 540, memory: "512MiB" }, async (req) => {
  const adminId = await requireAdmin(req);
  if (asObject(req.data).confirm !== RESET_CONFIRMATION) {
    throw new HttpsError("invalid-argument", `Type ${RESET_CONFIRMATION} to confirm.`);
  }
  const now = Date.now();

  // Who was playing, so their registrations can be re-queued after the wipe.
  const playersSnap = await db.collection("players").get();
  const wasActive = new Map(playersSnap.docs.map((d) => [d.id, (d.data() as Player).isActive]));

  const deleted: Record<string, number> = {};
  for (const name of WIPED_COLLECTIONS) {
    const ref = db.collection(name);
    deleted[name] = (await ref.count().get()).data().count;
    await db.recursiveDelete(ref);
  }

  const regs = await db.collection("registrations").where("status", "==", "approved").get();
  const writer = db.bulkWriter();
  let requeued = 0;
  let declined = 0;
  for (const d of regs.docs) {
    if (wasActive.get(d.id) === false) {
      writer.update(d.ref, { status: "rejected", decidedAt: now, decidedBy: adminId });
      declined++;
    } else {
      writer.update(d.ref, { status: "pending", createdAt: now, decidedAt: null, decidedBy: null });
      requeued++;
    }
  }
  writer.set(refs.state(), initialState(now));
  writer.set(auditRef(), auditEntry(adminId, "resetGame", null, { deleted, requeued, declined }, now));
  await writer.close();

  return { deleted, requeued, declined };
});
