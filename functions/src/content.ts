import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  DEFAULT_CHANGELOG,
  MAX_CONTENT_LENGTH,
  splitLegacyChangelog,
  validateDevlogEntry,
  type DevlogEntry,
  type SiteContent,
} from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, optString, refs, reqString, requireAdmin } from "./common";

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

const devlog = () => db.collection("devlog");

/** Admin: create a dev diary entry, or edit one by passing its `id`. */
export const saveDevlogEntry = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const data = asObject(req.data);
  const check = validateDevlogEntry(data.title, data.body, data.date);
  if (!check.ok) throw new HttpsError("invalid-argument", check.error);
  const id = optString(data, "id", 128);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const ref = id ? devlog().doc(id) : devlog().doc();
    let createdAt = now;
    if (id) {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "That entry no longer exists.");
      createdAt = (snap.data() as DevlogEntry).createdAt;
    }
    const entry: DevlogEntry = { id: ref.id, title: check.title, body: check.body, date: data.date as number, createdAt, updatedAt: now };
    tx.set(ref, entry);
    tx.set(auditRef(), auditEntry(adminId, id ? "editDevlogEntry" : "createDevlogEntry", ref.id, { title: entry.title }, now));
    return entry;
  });
});

export const deleteDevlogEntry = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const id = reqString(asObject(req.data), "id", 128);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const ref = devlog().doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That entry no longer exists.");
    tx.delete(ref);
    // Keep the text in the audit log so a mistaken delete can be undone by hand.
    const e = snap.data() as DevlogEntry;
    tx.set(auditRef(), auditEntry(adminId, "deleteDevlogEntry", id, { title: e.title, date: e.date, body: e.body }, now));
  });
  return { ok: true };
});

/**
 * Admin: turn the old single-page change log into diary entries. Uses the
 * built-in history (which has dates); entries whose title already exists are
 * skipped, so it's safe to press twice.
 */
export const importDevlog = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const now = Date.now();
  const legacy = splitLegacyChangelog(DEFAULT_CHANGELOG);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(devlog());
    const titles = new Set(existing.docs.map((d) => (d.data() as DevlogEntry).title.toLowerCase()));
    const added: string[] = [];
    legacy.forEach((e, i) => {
      if (titles.has(e.title.toLowerCase())) return;
      const ref = devlog().doc();
      // createdAt keeps text order (newest first) for entries on the same day.
      const entry: DevlogEntry = { id: ref.id, title: e.title, body: e.body, date: e.date ?? now, createdAt: now - i, updatedAt: now };
      tx.set(ref, entry);
      added.push(e.title);
    });
    if (added.length) tx.set(auditRef(), auditEntry(adminId, "importDevlog", null, { added }, now));
    return { added };
  });
});
