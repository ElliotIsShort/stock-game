import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { closeTimeError, closeTimeMessage, effectiveClosesAt, formatCloseTime, type Post } from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, ensureClosesAt, readState, refs, requireAdmin } from "./common";
import { enqueueDiscord } from "./discord";
import { liquidateDueMarginCalls, type LiquidationResult } from "./margin";
import { closeWeek, type CloseResult } from "./weeklyClose";

/**
 * Admin: set the exact instant the current week closes. Validated (at least
 * five minutes ahead), audited before/after and announced in the feed and on
 * Discord. Scheduled closes then move it on by whole weeks.
 */
export const setCloseTime = onCall(async (req) => {
  const adminId = await requireAdmin(req);
  const closesAt = asObject(req.data).closesAt;
  const now = Date.now();
  const error = closeTimeError(closesAt, now);
  if (error) throw new HttpsError("invalid-argument", error);
  const at = closesAt as number;

  return db.runTransaction(async (tx) => {
    const { state, exists } = await readState(tx, now);
    const before = effectiveClosesAt(state, now);
    if (exists) tx.update(refs.state(), { closesAt: at });
    else tx.set(refs.state(), { ...state, closesAt: at });

    const when = formatCloseTime(at);
    const was = formatCloseTime(before);
    const postRef = db.collection("posts").doc();
    const post: Post = {
      id: postRef.id,
      authorId: "system",
      authorName: "Market",
      taggedStockId: null,
      taggedName: null,
      text: `Week ${state.currentWeek} now closes ${when} UK time (was ${was}).`,
      linkedTradeId: null,
      linkedTradeSummary: null,
      reactions: {},
      reactionCount: 0,
      system: true,
      week: state.currentWeek,
      createdAt: now,
    };
    tx.set(postRef, post);
    enqueueDiscord(tx, "normal", "closeTime", closeTimeMessage(state.currentWeek, when, was), now);
    tx.set(auditRef(), auditEntry(adminId, "setCloseTime", "meta/state", { week: state.currentWeek, closesAt: { from: before, to: at } }, now));
    return { week: state.currentWeek, closesAt: at, previous: before };
  });
});

export interface SchedulerRun {
  /** The close time the scheduler saw (null when there's no game state yet). */
  closesAt: number | null;
  close: CloseResult | null;
  liquidations: LiquidationResult[];
}

/**
 * One scheduler tick. The cheap path (not due yet) is a single document read.
 * When due, `closeWeek` re-checks inside its transaction with the week number
 * this tick saw, so overlapping ticks can never close twice.
 */
export async function runScheduler(now: number): Promise<SchedulerRun> {
  const snap = await refs.state().get();
  if (!snap.exists) return { closesAt: null, close: null, liquidations: [] };
  const state = snap.data()!;
  const closesAt = typeof state.closesAt === "number" ? state.closesAt : await ensureClosesAt(now);
  let close: CloseResult | null = null;
  if (closesAt !== null && now >= closesAt) {
    close = await closeWeek({ trigger: "schedule", actorId: null, expectedWeek: state.currentWeek });
    logger.info("Scheduled weekly close", close);
  }
  // After any close (its allowances may have cleared a call): margin calls past their deadline.
  const liquidations = await liquidateDueMarginCalls(now);
  return { closesAt, close, liquidations };
}

/**
 * Every minute (Cloud Scheduler job #2 of the 3 free per billing account; the
 * other is `discordDigest`). While nothing is due each tick costs 2 reads
 * (meta/state + an empty margin-deadline query): ≈1,440 invocations and
 * ≈2,880 reads a day. No retries: the next tick is a minute away anyway.
 */
export const closeScheduler = onSchedule({ schedule: "every 1 minutes", timeoutSeconds: 300, retryCount: 0 }, async () => {
  try {
    await runScheduler(Date.now());
  } catch (err) {
    logger.error("closeScheduler failed", err);
  }
});
