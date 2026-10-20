import { onCall, HttpsError } from "firebase-functions/v2/https";
import type { Player, Registration, Stock } from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, refs, reqString, requireAdmin } from "./common";

/**
 * Admin: rename a player. Updates the player, their stock and registration,
 * and rewrites the denormalised name on their past trades and posts so the
 * feed is consistent. Friend-group scale (tens/hundreds of docs), so a batched
 * rewrite is fine.
 */
export const renamePlayer = onCall({ timeoutSeconds: 120 }, async (req) => {
  const adminId = await requireAdmin(req);
  const data = asObject(req.data);
  const uid = reqString(data, "uid", 128);
  const displayName = reqString(data, "displayName", 30).replace(/\s+/g, " ");
  if (displayName.length < 2) throw new HttpsError("invalid-argument", "Name must be at least 2 characters.");
  const now = Date.now();

  const oldName = await db.runTransaction(async (tx) => {
    const [playerSnap, stockSnap, clash] = await Promise.all([
      tx.get(refs.player(uid)),
      tx.get(refs.stock(uid)),
      tx.get(db.collection("registrations").where("displayNameLower", "==", displayName.toLowerCase())),
    ]);
    if (!playerSnap.exists) throw new HttpsError("not-found", "Player not found.");
    const taken = clash.docs.some((d) => d.id !== uid && (d.data() as Registration).status !== "rejected");
    if (taken) throw new HttpsError("already-exists", "That name is taken.");

    const prev = (playerSnap.data() as Player).displayName;
    tx.update(refs.player(uid), { displayName });
    if (stockSnap.exists) tx.update(refs.stock(uid), { displayName });
    tx.set(refs.registration(uid), { displayName, displayNameLower: displayName.toLowerCase() }, { merge: true });
    tx.set(auditRef(), auditEntry(adminId, "renamePlayer", uid, { from: prev, to: displayName }, now));
    return prev;
  });

  // Rewrite denormalised names on past trades and posts, outside the transaction
  // (can exceed the 500-write transaction limit on a busy game).
  await rewriteName(uid, displayName);
  return { ok: true, from: oldName, to: displayName };
});

async function rewriteName(uid: string, displayName: string): Promise<void> {
  const writer = db.bulkWriter();
  const [tradesByTrader, tradesByStock, postsByAuthor, postsByTag] = await Promise.all([
    db.collection("trades").where("traderId", "==", uid).get(),
    db.collection("trades").where("stockId", "==", uid).get(),
    db.collection("posts").where("authorId", "==", uid).get(),
    db.collection("posts").where("taggedStockId", "==", uid).get(),
  ]);
  for (const d of tradesByTrader.docs) writer.update(d.ref, { traderName: displayName });
  for (const d of tradesByStock.docs) writer.update(d.ref, { stockName: displayName });
  for (const d of postsByAuthor.docs) writer.update(d.ref, { authorName: displayName });
  for (const d of postsByTag.docs) writer.update(d.ref, { taggedName: displayName });
  await writer.close();
}
