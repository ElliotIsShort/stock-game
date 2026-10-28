import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { FieldValue, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import {
  DISCORD_ID_RE,
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
import { asObject, auditEntry, auditRef, db, refs, requireAdmin, requireAuth } from "./common";

/**
 * Discord, webhook-only: no bot process. Game code writes messages to
 * `discordOutbox` inside its own transaction; `discordDeliver` (a Firestore
 * trigger) posts them. The webhook URL lives only in the DISCORD_WEBHOOK_URL
 * Functions secret, never in Firestore. Routine posts are rate-limited per
 * hour; the overflow is "queued" and rolled into one digest by
 * `discordDigest` (hourly) or the admin "Send digest now" button.
 */
export const DISCORD_WEBHOOK_URL = defineSecret("DISCORD_WEBHOOK_URL");

const outbox = () => db.collection("discordOutbox");
const rateRef = () => db.doc("discordState/rate") as DocumentReference<DiscordRateState>;

/** Queue a Discord post as part of the caller's transaction (so it only goes out if the change commits). */
export function enqueueDiscord(tx: Transaction, priority: DiscordOutboxItem["priority"], kind: string, message: DiscordMessage, now: number): void {
  const ref = outbox().doc();
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

function webhookUrl(): string | null {
  let value = "";
  try {
    value = DISCORD_WEBHOOK_URL.value().trim();
  } catch {
    return null;
  }
  return value && isAllowedWebhookUrl(value) ? value : null;
}

async function mentionTargets(msgs: DiscordMessage[]): Promise<Map<string, MentionTarget>> {
  const uids = [...new Set(msgs.flatMap(mentionUids))];
  const out = new Map<string, MentionTarget>();
  if (uids.length === 0) return out;
  const snaps = await db.getAll(...uids.map((u) => refs.player(u)));
  for (const s of snaps) {
    const p = s.data() as Player | undefined;
    if (p) out.set(p.uid, { name: p.displayName, discordId: p.discordId });
  }
  return out;
}

type SendResult = { ok: true } | { ok: false; status: number | null; error: string };

async function post(url: string, msg: DiscordMessage, at: number): Promise<SendResult> {
  const targets = await mentionTargets([msg]);
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
  { document: "discordOutbox/{id}", secrets: [DISCORD_WEBHOOK_URL], retry: false },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const item = snap.data() as DiscordOutboxItem;
    if (item.status !== "pending") return;
    const cfg = mergeConfig((await refs.config().get()).data());
    const url = webhookUrl();
    if (!url || cfg.discordEnabled !== 1) {
      await mark(snap.ref, { status: "skipped" });
      return;
    }
    if (item.priority === "normal") {
      const now = Date.now();
      const allowed = await db.runTransaction(async (tx) => {
        const rate = await tx.get(rateRef());
        const d = rateDecision(rate.data(), now, cfg.discordMaxPerHour);
        if (d.allow) tx.set(rateRef(), d.next);
        return d.allow;
      });
      if (!allowed) {
        await mark(snap.ref, { status: "queued" });
        return;
      }
    }
    const res = await post(url, item.message, item.createdAt);
    if (res.ok) {
      await mark(snap.ref, { status: "sent", sentAt: Date.now() });
    } else if (res.status === 429 && item.priority === "normal") {
      // Discord's own rate limit: fold it into the next digest.
      await mark(snap.ref, { status: "queued" });
    } else {
      logger.warn("Discord post failed", { id: item.id, kind: item.kind, status: res.status, error: res.error });
      await mark(snap.ref, { status: "failed", error: res.error });
    }
  },
);

/** Post everything the rate limit held back as one message. */
export async function flushDigest(): Promise<{ sent: number; skipped?: string }> {
  const url = webhookUrl();
  if (!url) return { sent: 0, skipped: "DISCORD_WEBHOOK_URL isn't set." };
  const cfg = mergeConfig((await refs.config().get()).data());
  if (cfg.discordEnabled !== 1) return { sent: 0, skipped: "Discord posts are turned off in config." };
  const snap = await outbox().where("status", "==", "queued").limit(200).get();
  if (snap.empty) return { sent: 0 };
  const docs = [...snap.docs].sort((a, b) => (a.data() as DiscordOutboxItem).createdAt - (b.data() as DiscordOutboxItem).createdAt);
  const res = await post(url, digestMessage(docs.map((d) => (d.data() as DiscordOutboxItem).message)), Date.now());
  if (!res.ok) throw new HttpsError("unavailable", `Discord said no: ${res.status ?? ""} ${res.error}`.trim());
  const batch = db.batch();
  for (const d of docs) batch.update(d.ref, { status: "digested", sentAt: Date.now() });
  await batch.commit();
  return { sent: docs.length };
}

export const discordDigest = onSchedule({ schedule: "every 60 minutes", secrets: [DISCORD_WEBHOOK_URL] }, async () => {
  const res = await flushDigest();
  if (res.sent) logger.info("Discord digest sent", res);
});

/** Admin: post the digest now instead of waiting for the hourly run. */
export const sendDiscordDigest = onCall({ secrets: [DISCORD_WEBHOOK_URL] }, async (req) => {
  await requireAdmin(req);
  return flushDigest();
});

/** Admin: post a test message straight to the webhook and report what Discord said. */
export const testDiscord = onCall({ secrets: [DISCORD_WEBHOOK_URL] }, async (req) => {
  const adminId = await requireAdmin(req);
  const url = webhookUrl();
  if (!url) return { ok: false, error: "DISCORD_WEBHOOK_URL isn't set, or isn't a Discord webhook URL." };
  const res = await post(url, testMessage(adminId), Date.now());
  await auditRef().set(auditEntry(adminId, "testDiscord", null, { ok: res.ok }, Date.now()));
  return res.ok ? { ok: true } : { ok: false, error: `${res.status ?? "network"}: ${res.error}` };
});

/** Link (or unlink with null) your Discord user ID so posts can @mention you. */
export const setDiscordId = onCall(async (req) => {
  const uid = requireAuth(req);
  const raw = asObject(req.data).discordId;
  let discordId: string | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    if (typeof raw !== "string" || !DISCORD_ID_RE.test(raw.trim())) {
      throw new HttpsError("invalid-argument", "That doesn't look like a Discord user ID (17–20 digits).");
    }
    discordId = raw.trim();
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(refs.player(uid));
    if (!snap.exists) throw new HttpsError("not-found", "You're not an approved player.");
    if (discordId) {
      const clash = await tx.get(db.collection("players").where("discordId", "==", discordId));
      if (clash.docs.some((d) => d.id !== uid)) throw new HttpsError("already-exists", "Another player has linked that Discord account.");
    }
    tx.update(refs.player(uid), { discordId: discordId ?? FieldValue.delete() });
  });
  return { ok: true, discordId };
});
