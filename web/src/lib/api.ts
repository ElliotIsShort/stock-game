"use client";

import { httpsCallable } from "firebase/functions";
import type { AlertDirection, DevlogEntry, GameConfig, Post, PriceAlert, PrizeWinner, ReactionType, Short, TouchResult, Trade, TradeSide } from "@fsm/shared";
import { fb } from "./firebase";

/**
 * The server (game) the user is viewing. `GameProvider` sets it before any
 * child renders, and remounts on a change, so a request can never go to the
 * wrong server. Admin calls that target another one pass `serverId` explicitly.
 */
let currentServer: string | null = null;
export function setApiServer(id: string | null): void {
  currentServer = id;
}

/** Every callable that acts inside one server. `register`, `rejectPlayer`, the devlog and `createServer` are global. */
const SERVER_SCOPED = new Set([
  "touch", "setDiscordId", "createAlert", "cancelAlert", "markNotificationsRead", "testDiscord", "sendDiscordDigest", "trade",
  "createPost", "toggleReaction", "setStockPhoto", "approvePlayer", "addPlayerToServer", "deletePost", "delistPlayer", "updateConfig",
  "runWeeklyClose", "setCloseTime", "resetGame", "updateContent", "renamePlayer", "openShort", "closeShort", "setTicker",
  "setDiscordWebhook", "archiveServer", "unarchiveServer", "renameServer",
]);

async function call<Req, Res>(name: string, data: Req, serverId?: string | null): Promise<Res> {
  const fn = httpsCallable<unknown, Res>(fb().functions, name);
  const target = serverId ?? currentServer;
  const payload = SERVER_SCOPED.has(name) ? { ...(data as object), serverId: target } : data;
  const res = await fn(payload);
  return res.data;
}

/** Thin typed wrappers around the Cloud Functions. All balance changes happen server-side. */
export const api = {
  register: (displayName: string) => call<{ displayName: string }, { ok: true }>("register", { displayName }),
  touch: () => call<object, TouchResult>("touch", {}),
  /** Link your Discord user ID (or null to unlink) so Discord posts can @mention you. */
  setDiscordId: (discordId: string | null) => call<{ discordId: string | null }, { ok: true; discordId: string | null }>("setDiscordId", { discordId }),
  createAlert: (req: { stockId: string; direction: AlertDirection; price: number; discord: boolean }) => call<typeof req, PriceAlert>("createAlert", req),
  cancelAlert: (alertId: string) => call<{ alertId: string }, { ok: true }>("cancelAlert", { alertId }),
  markNotificationsRead: (ids?: string[]) => call<{ ids?: string[] }, { updated: number }>("markNotificationsRead", ids ? { ids } : {}),
  testDiscord: () => call<object, { ok: boolean; error?: string }>("testDiscord", {}),
  sendDiscordDigest: () => call<object, { sent: number; skipped?: string }>("sendDiscordDigest", {}),
  trade: (req: { stockId: string; side: TradeSide; amount: number; postText?: string }) => call<typeof req, Trade>("trade", req),
  createPost: (req: { text: string; taggedStockId?: string | null; linkedTradeId?: string | null }) => call<typeof req, Post>("createPost", req),
  toggleReaction: (postId: string, reaction: ReactionType) => call("toggleReaction", { postId, reaction }),
  /** Set your own stock photo (data URL), or pass null to remove. Admins can pass another uid to remove theirs. */
  setStockPhoto: (photo: string | null, uid?: string) =>
    call<{ photo: string | null; uid?: string }, { ok: true; hasPhoto: boolean }>("setStockPhoto", uid ? { photo, uid } : { photo }),
  // Admin
  setMaintenance: (enabled: boolean) => call<{ enabled: boolean }, { enabled: boolean }>("setMaintenance", { enabled }),
  /** Approve a pending registration into a chosen server. */
  approvePlayer: (uid: string, serverId: string) =>
    call<{ uid: string }, { startingCash: number; listingPrice: number }>("approvePlayer", { uid }, serverId),
  /** Add an already-approved user to another server (optionally under a different name there). */
  addPlayerToServer: (uid: string, serverId: string, displayName?: string) =>
    call<{ uid: string; displayName?: string }, { startingCash: number; listingPrice: number }>(
      "addPlayerToServer",
      displayName ? { uid, displayName } : { uid },
      serverId,
    ),
  createServer: (req: { name: string; closesAt: number; copyConfigFrom?: string }) =>
    call<typeof req, { serverId: string; name: string }>("createServer", req),
  archiveServer: (serverId: string) => call<object, { serverId: string; status: string }>("archiveServer", {}, serverId),
  unarchiveServer: (serverId: string) => call<object, { serverId: string; status: string }>("unarchiveServer", {}, serverId),
  renameServer: (serverId: string, name: string) => call<{ name: string }, { serverId: string; from: string; to: string }>("renameServer", { name }, serverId),
  /** Set (or clear with "") a server's Discord webhook. The URL is write-only: it can never be read back. */
  setDiscordWebhook: (serverId: string, url: string) => call<{ url: string }, { ok: true; set: boolean }>("setDiscordWebhook", { url }, serverId),
  rejectPlayer: (uid: string) => call("rejectPlayer", { uid }),
  deletePost: (postId: string, reason?: string) => call("deletePost", { postId, reason }),
  delistPlayer: (uid: string) => call<{ uid: string }, { payouts: { uid: string; cash: number }[] }>("delistPlayer", { uid }),
  updateConfig: (patch: Partial<GameConfig>) => call<{ patch: Partial<GameConfig> }, GameConfig>("updateConfig", { patch }),
  runWeeklyClose: (expectedWeek: number) =>
    call<{ expectedWeek: number }, { closed: boolean; week?: number; winners?: PrizeWinner[]; prize?: number; reason?: string }>(
      "runWeeklyClose",
      { expectedWeek },
    ),
  /** Set the exact instant (epoch ms) the current week closes. */
  setCloseTime: (closesAt: number) =>
    call<{ closesAt: number }, { week: number; closesAt: number; previous: number }>("setCloseTime", { closesAt }),
  resetGame: (confirm: string) =>
    call<{ confirm: string }, { deleted: Record<string, number>; requeued: number; declined: number }>("resetGame", { confirm }),
  updateContent: (patch: { rules?: string; changelog?: string }) => call<typeof patch, { ok: true }>("updateContent", patch),
  /** Create a dev diary entry, or edit one by passing its id. */
  saveDevlogEntry: (entry: { id?: string; title: string; body: string; date: number }) => call<typeof entry, DevlogEntry>("saveDevlogEntry", entry),
  deleteDevlogEntry: (id: string) => call<{ id: string }, { ok: true }>("deleteDevlogEntry", { id }),
  importDevlog: () => call<object, { added: string[] }>("importDevlog", {}),
  renamePlayer: (uid: string, displayName: string) =>
    call<{ uid: string; displayName: string }, { ok: true; from: string; to: string }>("renamePlayer", { uid, displayName }),
  openShort: (req: { stockId: string; shares: number; postText?: string }) => call<typeof req, Short>("openShort", req),
  closeShort: (req: { shortId: string; postText?: string }) => call<typeof req, Short>("closeShort", req),
  /** Change your own ticker; admins can pass another player's uid. */
  setTicker: (ticker: string, uid?: string) =>
    call<{ ticker: string; uid?: string }, { ticker: string; changed: boolean }>("setTicker", uid ? { ticker, uid } : { ticker }),
};

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message);
  return "Something went wrong.";
}
