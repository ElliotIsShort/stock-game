import { onCall, HttpsError } from "firebase-functions/v2/https";
import { REACTION_TYPES, type Player, type Post, type ReactionType, type Stock, type Trade } from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, optString, readConfig, readState, refs, reqString, requireAdmin, requireAuth } from "./common";
import { tradeSummary } from "./trading";

/**
 * Create a post. Standalone, tagged to a person (including yourself), and/or
 * linked to one of your own trades. Posts never affect price.
 */
export const createPost = onCall(async (req) => {
  const uid = requireAuth(req);
  const data = asObject(req.data);
  const text = reqString(data, "text", 5000);
  const taggedStockId = optString(data, "taggedStockId", 128);
  const linkedTradeId = optString(data, "linkedTradeId", 128);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const cfg = await readConfig(tx);
    const { state } = await readState(tx, now);
    if (text.length > cfg.maxPostLength) throw new HttpsError("invalid-argument", `Post must be at most ${cfg.maxPostLength} characters.`);
    const playerSnap = await tx.get(refs.player(uid));
    if (!playerSnap.exists) throw new HttpsError("permission-denied", "You're not an approved player.");
    const player = playerSnap.data() as Player;
    if (!player.isActive) throw new HttpsError("permission-denied", "Your account is delisted.");

    let taggedName: string | null = null;
    let tradeDoc: Trade | null = null;
    let effectiveTag = taggedStockId;

    if (linkedTradeId) {
      const tradeSnap = await tx.get(db.doc(`trades/${linkedTradeId}`));
      if (!tradeSnap.exists) throw new HttpsError("not-found", "Trade not found.");
      tradeDoc = tradeSnap.data() as Trade;
      // You can only annotate your own trades — which by construction are
      // never trades of your own stock.
      if (tradeDoc.traderId !== uid) throw new HttpsError("permission-denied", "You can only link posts to your own trades.");
      if (tradeDoc.stockId === uid) throw new HttpsError("permission-denied", "You can't link a post to a trade of your own stock.");
      if (tradeDoc.linkedPostId) throw new HttpsError("already-exists", "That trade already has a post.");
      effectiveTag = effectiveTag ?? tradeDoc.stockId;
    }
    if (effectiveTag) {
      const stockSnap = await tx.get(refs.stock(effectiveTag));
      if (!stockSnap.exists) throw new HttpsError("not-found", "Tagged person not found.");
      taggedName = (stockSnap.data() as Stock).displayName;
    }

    const postRef = db.collection("posts").doc();
    const post: Post = {
      id: postRef.id,
      authorId: uid,
      authorName: player.displayName,
      taggedStockId: effectiveTag,
      taggedName,
      text,
      linkedTradeId: tradeDoc ? tradeDoc.id : null,
      linkedTradeSummary: tradeDoc ? tradeSummary(tradeDoc) : null,
      reactions: {},
      reactionCount: 0,
      system: false,
      week: state.currentWeek,
      createdAt: now,
    };
    tx.set(postRef, post);
    if (tradeDoc) tx.update(db.doc(`trades/${tradeDoc.id}`), { linkedPostId: postRef.id });
    tx.update(refs.player(uid), { lastActiveAt: now, isIdle: false });
    return post;
  });
});

/** Toggle a reaction. Purely social — never touches prices. */
export const toggleReaction = onCall(async (req) => {
  const uid = requireAuth(req);
  const data = asObject(req.data);
  const postId = reqString(data, "postId", 128);
  const reaction = data.reaction as ReactionType;
  if (!REACTION_TYPES.includes(reaction)) throw new HttpsError("invalid-argument", "Unknown reaction.");

  return db.runTransaction(async (tx) => {
    const playerSnap = await tx.get(refs.player(uid));
    if (!playerSnap.exists || !(playerSnap.data() as Player).isActive) throw new HttpsError("permission-denied", "Players only.");
    const ref = db.doc(`posts/${postId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Post not found.");
    const post = snap.data() as Post;
    const reactions = { ...(post.reactions ?? {}) };
    const list = new Set(reactions[reaction] ?? []);
    if (list.has(uid)) list.delete(uid);
    else list.add(uid);
    reactions[reaction] = [...list];
    const reactionCount = Object.values(reactions).reduce((n, l) => n + (l?.length ?? 0), 0);
    tx.update(ref, { reactions, reactionCount });
    return { reactions, reactionCount };
  });
});

/** Admin moderation: delete a post. The deleted text is kept in the audit log. */
export const deletePost = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const data = asObject(req.data);
  const postId = reqString(data, "postId", 128);
  const reason = optString(data, "reason", 500);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`posts/${postId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Post not found.");
    const post = snap.data() as Post;
    const tradeRef = post.linkedTradeId ? db.doc(`trades/${post.linkedTradeId}`) : null;
    const tradeSnap = tradeRef ? await tx.get(tradeRef) : null;
    tx.delete(ref);
    if (tradeRef && tradeSnap?.exists) tx.update(tradeRef, { linkedPostId: null });
    tx.set(
      auditRef(),
      auditEntry(adminId, "deletePost", postId, { authorId: post.authorId, authorName: post.authorName, text: post.text, reason }, now),
    );
  });
  return { ok: true };
});
