import { onCall, HttpsError } from "firebase-functions/v2/https";
import { parsePhotoDataUrl, type Player, type StockPhoto } from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, isAdmin, optString, refs, requireAuth } from "./common";

/**
 * Set or remove your own stock's photo. Pass `photo: null` to remove.
 * Admins may also remove (never set) someone else's photo, as a moderation
 * safety valve; that is audit-logged.
 */
export const setStockPhoto = onCall(async (req) => {
  const uid = requireAuth(req);
  const data = asObject(req.data);
  const target = optString(data, "uid", 128) ?? uid;
  const photo = data.photo ?? null;
  const now = Date.now();

  const forSomeoneElse = target !== uid;
  if (forSomeoneElse) {
    if (!(await isAdmin(uid))) throw new HttpsError("permission-denied", "You can only change your own photo.");
    if (photo !== null) throw new HttpsError("invalid-argument", "Admins can only remove other players' photos.");
  }
  let dataUrl: string | null = null;
  if (photo !== null) {
    const parsed = parsePhotoDataUrl(photo);
    if (!parsed.ok) throw new HttpsError("invalid-argument", parsed.error);
    dataUrl = photo as string;
  }

  await db.runTransaction(async (tx) => {
    const playerSnap = await tx.get(refs.player(target));
    if (!playerSnap.exists) throw new HttpsError("not-found", forSomeoneElse ? "Player not found." : "You're not an approved player.");
    if (!forSomeoneElse && !(playerSnap.data() as Player).isActive) {
      throw new HttpsError("permission-denied", "Your account is delisted.");
    }
    if (dataUrl) {
      const doc: StockPhoto = { uid: target, dataUrl, updatedAt: now };
      tx.set(refs.photo(target), doc);
    } else {
      tx.delete(refs.photo(target));
    }
    if (forSomeoneElse) tx.set(auditRef(), auditEntry(uid, "removePhoto", target, {}, now));
  });
  return { ok: true, hasPhoto: dataUrl !== null };
});
