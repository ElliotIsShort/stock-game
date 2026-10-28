"use client";

import { httpsCallable } from "firebase/functions";
import type { AlertDirection, DevlogEntry, GameConfig, Post, PriceAlert, PrizeWinner, ReactionType, Short, TouchResult, Trade, TradeSide } from "@fsm/shared";
import { fb } from "./firebase";

async function call<Req, Res>(name: string, data: Req): Promise<Res> {
  const fn = httpsCallable<Req, Res>(fb().functions, name);
  const res = await fn(data);
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
  approvePlayer: (uid: string) => call<{ uid: string }, { startingCash: number; listingPrice: number }>("approvePlayer", { uid }),
  rejectPlayer: (uid: string) => call("rejectPlayer", { uid }),
  deletePost: (postId: string, reason?: string) => call("deletePost", { postId, reason }),
  delistPlayer: (uid: string) => call<{ uid: string }, { payouts: { uid: string; cash: number }[] }>("delistPlayer", { uid }),
  updateConfig: (patch: Partial<GameConfig>) => call<{ patch: Partial<GameConfig> }, GameConfig>("updateConfig", { patch }),
  runWeeklyClose: (expectedWeek: number) =>
    call<{ expectedWeek: number }, { closed: boolean; week?: number; winners?: PrizeWinner[]; prize?: number; reason?: string }>(
      "runWeeklyClose",
      { expectedWeek },
    ),
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
