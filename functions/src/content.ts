import { onCall, HttpsError } from "firebase-functions/v2/https";
import { MAX_CONTENT_LENGTH, type SiteContent } from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, refs, requireAdmin } from "./common";

/** Admin: edit the Rules and/or Change log shown to players. */
export const updateContent = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const data = asObject(req.data);
  const patch: Partial<Pick<SiteContent, "rules" | "changelog">> = {};
  for (const key of ["rules", "changelog"] as const) {
    if (data[key] === undefined) continue;
    const v = data[key];
    if (typeof v !== "string" || v.length > MAX_CONTENT_LENGTH) {
      throw new HttpsError("invalid-argument", `${key} must be text under ${MAX_CONTENT_LENGTH} characters.`);
    }
    patch[key] = v;
  }
  if (Object.keys(patch).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    tx.set(refs.content(), { ...patch, updatedAt: now }, { merge: true });
    tx.set(auditRef(), auditEntry(adminId, "updateContent", "content/global", { fields: Object.keys(patch) }, now));
  });
  return { ok: true };
});
