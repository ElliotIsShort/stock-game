import { HttpsError } from "firebase-functions/v2/https";
import type { Player } from "@fsm/shared";
import { gameCall, gameCtx, auditEntry, auditRef, db, reqString, type Refs } from "./common";

/**
 * Admin: rename a player in one game. Updates the player and their stock there (not their account-wide registration),
 * and rewrites the denormalised name on their past trades and posts so the
 * feed is consistent. Friend-group scale (tens/hundreds of docs), so a batched
 * rewrite is fine.
 */
export const renamePlayer = gameCall({ timeoutSeconds: 120 }, async (req) => {
  const { uid: adminId, serverId, R, data } = await gameCtx(req, { admin: true });
  const uid = reqString(data, "uid", 128);
  const displayName = reqString(data, "displayName", 30).replace(/\s+/g, " ");
  if (displayName.length < 2) throw new HttpsError("invalid-argument", "Name must be at least 2 characters.");
  const now = Date.now();

  const oldName = await db.runTransaction(async (tx) => {
    const [playerSnap, stockSnap, playersSnap] = await Promise.all([tx.get(R.player(uid)), tx.get(R.stock(uid)), tx.get(R.col("players"))]);
    if (!playerSnap.exists) throw new HttpsError("not-found", "Player not found.");
    // Names are unique within one game only.
    const taken = playersSnap.docs.some((d) => d.id !== uid && (d.data() as Player).displayName.toLowerCase() === displayName.toLowerCase());
    if (taken) throw new HttpsError("already-exists", "That name is taken.");

    const prev = (playerSnap.data() as Player).displayName;
    tx.update(R.player(uid), { displayName });
    if (stockSnap.exists) tx.update(R.stock(uid), { displayName });
    tx.set(auditRef(), auditEntry(adminId, "renamePlayer", uid, { from: prev, to: displayName }, now, serverId));
    return prev;
  });

  // Rewrite denormalised names on past trades and posts, outside the transaction
  // (can exceed the 500-write transaction limit on a busy game).
  await rewriteName(R, uid, displayName);
  return { ok: true, from: oldName, to: displayName };
});

async function rewriteName(R: Refs, uid: string, displayName: string): Promise<void> {
  const writer = db.bulkWriter();
  const [tradesByTrader, tradesByStock, postsByAuthor, postsByTag] = await Promise.all([
    R.col("trades").where("traderId", "==", uid).get(),
    R.col("trades").where("stockId", "==", uid).get(),
    R.col("posts").where("authorId", "==", uid).get(),
    R.col("posts").where("taggedStockId", "==", uid).get(),
  ]);
  for (const d of tradesByTrader.docs) writer.update(d.ref, { traderName: displayName });
  for (const d of tradesByStock.docs) writer.update(d.ref, { stockName: displayName });
  for (const d of postsByAuthor.docs) writer.update(d.ref, { authorName: displayName });
  for (const d of postsByTag.docs) writer.update(d.ref, { taggedName: displayName });
  await writer.close();
}
