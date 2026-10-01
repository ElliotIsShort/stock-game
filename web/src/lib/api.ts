"use client";

import { httpsCallable } from "firebase/functions";
import type { GameConfig, Post, ReactionType, Trade, TradeSide } from "@fsm/shared";
import { fb } from "./firebase";

async function call<Req, Res>(name: string, data: Req): Promise<Res> {
  const fn = httpsCallable<Req, Res>(fb().functions, name);
  const res = await fn(data);
  return res.data;
}

/** Thin typed wrappers around the Cloud Functions. All balance changes happen server-side. */
export const api = {
  register: (displayName: string) => call<{ displayName: string }, { ok: true }>("register", { displayName }),
  touch: () => call<object, { player: boolean; reactivated: boolean }>("touch", {}),
  trade: (req: { stockId: string; side: TradeSide; amount: number; postText?: string }) => call<typeof req, Trade>("trade", req),
  createPost: (req: { text: string; taggedStockId?: string | null; linkedTradeId?: string | null }) => call<typeof req, Post>("createPost", req),
  toggleReaction: (postId: string, reaction: ReactionType) => call("toggleReaction", { postId, reaction }),
  // Admin
  approvePlayer: (uid: string) => call<{ uid: string }, { startingCash: number; listingPrice: number }>("approvePlayer", { uid }),
  rejectPlayer: (uid: string) => call("rejectPlayer", { uid }),
  deletePost: (postId: string, reason?: string) => call("deletePost", { postId, reason }),
  delistPlayer: (uid: string) => call<{ uid: string }, { payouts: { uid: string; cash: number }[] }>("delistPlayer", { uid }),
  updateConfig: (patch: Partial<GameConfig>) => call<{ patch: Partial<GameConfig> }, GameConfig>("updateConfig", { patch }),
  runWeeklyClose: (expectedWeek: number) =>
    call<{ expectedWeek: number }, { closed: boolean; week?: number; winner?: string | null; prize?: number; reason?: string }>(
      "runWeeklyClose",
      { expectedWeek },
    ),
};

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message);
  return "Something went wrong.";
}
