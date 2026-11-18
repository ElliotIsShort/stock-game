import { HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { FieldValue, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import {
  DISCORD_ID_RE,
  isServerCode,
  digestMessage,
  mentionUids,
  mergeConfig,
  rateDecision,
  renderWebhookBody,
  testMessage,
  type DiscordMessage,
  type DiscordOutboxItem,
  type DiscordRateState,
  type GameConfig,
  type GameState,
  type MentionTarget,
  type Player,
} from "@fsm/shared";
import { gameCall, gameCtx, globalRefs, inMaintenance, auditEntry, auditRef, db, refs, type Refs } from "./common";

/**
 * Discord, webhook-only: no bot process. Game code writes messages to the
 * server's `discordOutbox` inside its own transaction; `discordDeliver` (a
 * Firestore trigger) posts them. Each server has its OWN webhook, stored in
 * the server-only doc `servers/{id}/private/discord` (clients can never read
 * it). There is deliberately no fallback to any other server's webhook, so
 * nothing in one server can reach another's channel. Routine posts are
 * rate-limited per hour; the overflow is "queued" and rolled into one digest
 * by `discordDigest` (hourly) or the admin "Send digest now" button.
 */

/** Queue a Discord post as part of the caller's transaction (so it only goes out if the change commits). */
export function enqueueDiscord(tx: Transaction, R: Refs, priority: DiscordOutboxItem["priority"], kind: string, message: DiscordMessage, now: number): void {
  const ref = R.outbox().doc();
  const item: DiscordOutboxItem = { id: ref.id, priority, kind, message, status: "pending", createdAt: now };
  tx.set(ref, stripUndefined(item));
}

/** A trade or short counts as "big" relative to average net worth. */
export function isBigTrade(cash: number, state: Pick<GameState, "avgNetWorth">, cfg: Pick<GameConfig, "discordBigTradePct" | "baseStartingCash">): boolean {
  const avg = state.avgNetWorth && state.avgNetWorth > 0 ? state.avgNetWorth : cfg.baseStartingCash;
  return cash >= cfg.discordBigTradePct * avg;
}

/** Firestore rejects undefined fields; message builders leave optional ones out. */
function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Only real Discord webhook URLs (plus a local capture server inside the emulator, for tests). */
export function isAllowedWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" && (u.hostname === "discord.com" || u.hostname === "discordapp.com") && u.pathname.startsWith("/api/webhooks/")) return true;
    return process.env.FUNCTIONS_EMULATOR === "true" && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

/** This server's webhook, or null when none is set (or it isn't a real webhook URL). */
async function webhookUrl(R: Refs): Promise<string | null> {
  const value = ((await R.privateDiscord().get()).data()?.webhookUrl as string | undefined)?.trim();
  return value && isAllowedWebhookUrl(value) ? value : null;
}

async function mentionTargets(R: Refs, msgs: DiscordMessage[]): Promise<Map<string, MentionTarget>> {
  const uids = [...new Set(msgs.flatMap(mentionUids))];
  const out = new Map<string, MentionTarget>();
  if (uids.length === 0) return out;
  const snaps = await db.getAll(...uids.map((u) => R.player(u)));
  for (const s of snaps) {
    const p = s.data() as Player | undefined;
    if (p) out.set(p.uid, { name: p.displayName, discordId: p.discordId });
  }
  return out;
}

type SendResult = { ok: true } | { ok: false; status: number | null; error: string };

async function post(R: Refs, url: string, msg: DiscordMessage, at: number): Promise<SendResult> {
  const targets = await mentionTargets(R, [msg]);
  const body = renderWebhookBody(msg, (uid) => targets.get(uid), at);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) || res.statusText };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Update an outbox doc, ignoring it if it's gone (e.g. a reset). */
async function mark(ref: DocumentReference, patch: Partial<DiscordOutboxItem>): Promise<void> {
  await ref.update(patch).catch(() => undefined);
}

export const discordDeliver = onDocumentCreated(
  { document: "servers/{serverId}/discordOutbox/{id}", retry: false },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const item = snap.data() as DiscordOutboxItem;
    if (item.status !== "pending") return;
    if (await inMaintenance()) return;
    const serverId = event.params.serverId;
    if (!isServerCode(serverId)) return;
    const R = refs(serverId);
    const server = (await R.server().get()).data();
    const cfg = mergeConfig((await R.config().get()).data());
    // Archived servers and servers without their own webhook post nothing (never another server's).
    const url = server?.status === "active" ? await webhookUrl(R) : null;
    if (!url || cfg.discordEnabled !== 1) {
      await mark(snap.ref, { status: "skipped" });
      return;
    }
    if (item.priority === "normal") {
      const now = Date.now();
      const allowed = await db.runTransaction(async (tx) => {
        const rate = await tx.get(R.discordRate());
        const d = rateDecision(rate.data() as DiscordRateState | undefined, now, cfg.discordMaxPerHour);
        if (d.allow) tx.set(R.discordRate(), d.next);
        return d.allow;
      });
      if (!allowed) {
        await mark(snap.ref, { status: "queued" });
        return;
      }
    }
    const res = await post(R, url, item.message, item.createdAt);
    if (res.ok) {
      await mark(snap.ref, { status: "sent", sentAt: Date.now() });
    } else if (res.status === 429 && item.priority === "normal") {
      // Discord's own rate limit: fold it into the next digest.
      await mark(snap.ref, { status: "queued" });
    } else {
      logger.warn("Discord post failed", { serverId, id: item.id, kind: item.kind, status: res.status, error: res.error });
      await mark(snap.ref, { status: "failed", error: res.error });
    }
  },
);

/** Post everything the rate limit held back in one server as one message. */
export async function flushDigest(R: Refs): Promise<{ sent: number; skipped?: string }> {
  const url = await webhookUrl(R);
  if (!url) return { sent: 0, skipped: "No Discord webhook is set." };
  const cfg = mergeConfig((await R.config().get()).data());
  if (cfg.discordEnabled !== 1) return { sent: 0, skipped: "Discord posts are turned off in config." };
  const snap = await R.outbox().where("status", "==", "queued").limit(200).get();
  if (snap.empty) return { sent: 0 };
  const docs = [...snap.docs].sort((a, b) => (a.data() as DiscordOutboxItem).createdAt - (b.data() as DiscordOutboxItem).createdAt);
  const res = await post(R, url, digestMessage(docs.map((d) => (d.data() as DiscordOutboxItem).message)), Date.now());
  if (!res.ok) throw new HttpsError("unavailable", `Discord said no: ${res.status ?? ""} ${res.error}`.trim());
  const batch = db.batch();
  for (const d of docs) batch.update(d.ref, { status: "digested", sentAt: Date.now() });
  await batch.commit();
  return { sent: docs.length };
}

/** Hourly: one digest per ACTIVE server, each to its own webhook. One failing server never blocks the others. */
export const discordDigest = onSchedule({ schedule: "every 60 minutes" }, async () => {
  if (await inMaintenance()) return;
  const servers = await globalRefs.servers().where("status", "==", "active").get();
  for (const s of servers.docs) {
    try {
      const res = await flushDigest(refs(s.id));
      if (res.sent) logger.info("Discord digest sent", { serverId: s.id, ...res });
    } catch (err) {
      logger.error("Discord digest failed", { serverId: s.id, err });
    }
  }
});

/** Admin: post this server's digest now instead of waiting for the hourly run. */
export const sendDiscordDigest = gameCall(async (req) => {
  const { R } = await gameCtx(req, { admin: true });
  return flushDigest(R);
});

/** Admin: post a test message straight to this server's webhook and report what Discord said. */
export const testDiscord = gameCall(async (req) => {
  const { uid: adminId, serverId, R } = await gameCtx(req, { admin: true });
  const url = await webhookUrl(R);
  if (!url) return { ok: false, error: "No Discord webhook is set for this server." };
  const res = await post(R, url, testMessage(adminId), Date.now());
  await auditRef().set(auditEntry(adminId, "testDiscord", null, { ok: res.ok }, Date.now(), serverId));
  return res.ok ? { ok: true } : { ok: false, error: `${res.status ?? "network"}: ${res.error}` };
});

/**
 * Admin: set (or clear with an empty url) a server's Discord webhook. Written
 * to a server-only doc; the URL is never returned or readable by clients.
 * `servers/{id}.hasDiscordWebhook` is the only thing the UI can see.
 */
export const setDiscordWebhook = gameCall(async (req) => {
  const { uid: adminId, serverId, R, data } = await gameCtx(req, { admin: true });
  const raw = data.url;
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw new HttpsError("invalid-argument", "url must be a string.");
  const url = (raw ?? "").trim();
  if (url && !isAllowedWebhookUrl(url)) throw new HttpsError("invalid-argument", "That isn't a Discord webhook URL (discord.com/api/webhooks/...).");
  const now = Date.now();
  const batch = db.batch();
  if (url) batch.set(R.privateDiscord(), { webhookUrl: url, updatedAt: now });
  else batch.delete(R.privateDiscord());
  batch.update(R.server(), { hasDiscordWebhook: Boolean(url) });
  batch.set(auditRef(), auditEntry(adminId, "setDiscordWebhook", null, { set: Boolean(url) }, now, serverId));
  await batch.commit();
  return { ok: true, set: Boolean(url) };
});

/** Link (or unlink with null) your Discord user ID so posts can @mention you (per server). */
export const setDiscordId = gameCall(async (req) => {
  const { uid, R, data } = await gameCtx(req);
  const raw = data.discordId;
  let discordId: string | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    if (typeof raw !== "string" || !DISCORD_ID_RE.test(raw.trim())) {
      throw new HttpsError("invalid-argument", "That doesn't look like a Discord user ID (17–20 digits).");
    }
    discordId = raw.trim();
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(R.player(uid));
    if (!snap.exists) throw new HttpsError("not-found", "You're not an approved player.");
    if (discordId) {
      const clash = await tx.get(R.col("players").where("discordId", "==", discordId));
      if (clash.docs.some((d) => d.id !== uid)) throw new HttpsError("already-exists", "Another player has linked that Discord account.");
    }
    tx.update(R.player(uid), { discordId: discordId ?? FieldValue.delete() });
  });
  return { ok: true, discordId };
});
