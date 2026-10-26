"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { collection, doc, query, where } from "firebase/firestore";
import {
  DEFAULT_CONFIG,
  leaderboardScore,
  mergeConfig,
  netWorth,
  quoteCloseShort,
  shortsLiability,
  type GameConfig,
  type GameState,
  type Holding,
  type Player,
  type Registration,
  type Short,
  type Stock,
  type StockPhoto,
} from "@fsm/shared";
import { fb, firebaseConfigured } from "@/lib/firebase";
import { useDoc, useQuery } from "@/lib/hooks";
import { api } from "@/lib/api";

export interface PlayerView extends Player {
  netWorth: number;
  score: number;
  holdingsValue: number;
}

interface GameContextValue {
  configured: boolean;
  authLoading: boolean;
  user: User | null;
  registration: Registration | null;
  me: Player | null;
  /** Show admin UI. False while an admin is previewing the site as a player. */
  isAdmin: boolean;
  /** Has an admins/{uid} doc, regardless of preview. Only use this for the preview toggle itself. */
  isRealAdmin: boolean;
  /** An admin is currently viewing the site as a player. */
  previewingAsPlayer: boolean;
  setPreviewAsPlayer: (on: boolean) => void;
  isMember: boolean;
  loadingMembership: boolean;
  signOut: () => Promise<void>;
  // Market data (only populated for members)
  config: GameConfig;
  state: GameState | null;
  stocks: Stock[];
  stockById: Map<string, Stock>;
  players: PlayerView[];
  playerById: Map<string, PlayerView>;
  holdings: Holding[];
  myHoldings: Holding[];
  /** The signed-in player's open short positions. */
  myShorts: Short[];
  /** Stock photo data URL by uid, if they've set one. */
  photoOf: (uid: string) => string | undefined;
}

const GameContext = createContext<GameContextValue | null>(null);
const PREVIEW_KEY = "fsm:viewAsPlayer";

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used inside GameProvider");
  return ctx;
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(firebaseConfigured);

  useEffect(() => {
    if (!firebaseConfigured) return;
    return onAuthStateChanged(fb().auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
  }, []);

  const uid = user?.uid ?? null;
  // Never initialise Firebase during the static build's prerender.
  const db = firebaseConfigured && typeof window !== "undefined" ? fb().db : null;

  const registration = useDoc<Registration>(db && uid ? doc(db, "registrations", uid) : null, [uid]);
  const adminDoc = useDoc<object>(db && uid ? doc(db, "admins", uid) : null, [uid]);
  const meDoc = useDoc<Player>(db && uid ? doc(db, "players", uid) : null, [uid]);

  // "View as player": admins can hide every admin affordance to see what players see.
  // UI-only — the server still treats them as an admin. Remembered for the browser tab.
  const realAdmin = Boolean(adminDoc.data);
  const [previewAsPlayer, setPreviewState] = useState(false);
  useEffect(() => {
    setPreviewState(sessionStorage.getItem(PREVIEW_KEY) === "1");
  }, []);
  const setPreviewAsPlayer = useCallback((on: boolean) => {
    if (on) sessionStorage.setItem(PREVIEW_KEY, "1");
    else sessionStorage.removeItem(PREVIEW_KEY);
    setPreviewState(on);
  }, []);
  const previewing = realAdmin && previewAsPlayer;
  const isAdmin = realAdmin && !previewing;
  // An admin with no player account previews what a not-yet-approved signup sees.
  const isMember = Boolean(meDoc.data) || isAdmin;
  const loadingMembership = registration.loading || adminDoc.loading || meDoc.loading;
  const liveDb = db && isMember ? db : null;
  const on = Boolean(liveDb);

  const stocksQ = useQuery<Stock>(liveDb ? collection(liveDb, "stocks") : null, [on]);
  const playersQ = useQuery<Player>(liveDb ? collection(liveDb, "players") : null, [on]);
  const holdingsQ = useQuery<Holding>(liveDb ? collection(liveDb, "holdings") : null, [on]);
  const photosQ = useQuery<StockPhoto>(liveDb ? collection(liveDb, "photos") : null, [on]);
  // All open shorts: needed so the leaderboard can offset everyone's net worth,
  // not just the signed-in player's. Members may read all shorts.
  const openShortsQ = useQuery<Short>(
    liveDb ? query(collection(liveDb, "shorts"), where("status", "==", "open")) : null,
    [on],
  );
  const stateDoc = useDoc<GameState>(liveDb ? doc(liveDb, "meta", "state") : null, [on]);
  const configDoc = useDoc<Partial<GameConfig>>(liveDb ? doc(liveDb, "config", "global") : null, [on]);

  // Record activity once per session; silently reactivates idle players.
  const touched = useRef<string | null>(null);
  useEffect(() => {
    if (meDoc.data && uid && touched.current !== uid) {
      touched.current = uid;
      api.touch().catch(() => undefined);
    }
  }, [meDoc.data, uid]);

  const value = useMemo<GameContextValue>(() => {
    const stocks = stocksQ.data;
    const feePct = (configDoc.data ? mergeConfig(configDoc.data) : DEFAULT_CONFIG).tradingFeePct;
    const photoById = new Map(photosQ.data.map((p) => [p.uid, p.dataUrl]));
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const priceOf = (id: string) => {
      const s = stockById.get(id);
      return s && s.listed ? s.price : undefined;
    };
    const byUid = new Map<string, Holding[]>();
    for (const h of holdingsQ.data) {
      const list = byUid.get(h.uid) ?? [];
      list.push(h);
      byUid.set(h.uid, list);
    }
    // Open shorts by owner, to subtract their liability from net worth (Option B).
    const shortsByOwner = new Map<string, Short[]>();
    for (const s of openShortsQ.data) {
      const list = shortsByOwner.get(s.ownerId) ?? [];
      list.push(s);
      shortsByOwner.set(s.ownerId, list);
    }
    const liabilityOf = (ownerUid: string) => {
      const list = shortsByOwner.get(ownerUid);
      if (!list || list.length === 0) return 0;
      return shortsLiability(list, (i) => {
        const stock = stockById.get(list[i].stockId);
        if (!stock || !stock.listed || !(stock.poolShares > list[i].shares)) return undefined;
        try {
          return quoteCloseShort(stock, list[i].shares, feePct).cost;
        } catch {
          return undefined;
        }
      });
    };
    const players: PlayerView[] = playersQ.data.map((p) => {
      const holdingsValue = netWorth(p.cash, byUid.get(p.uid) ?? [], priceOf) - p.cash;
      const nw = p.cash + holdingsValue - liabilityOf(p.uid);
      return {
        ...p,
        netWorth: nw,
        holdingsValue,
        score: leaderboardScore(nw, p.startingCash, p.totalAllowances),
      };
    });
    return {
      configured: firebaseConfigured,
      authLoading,
      user,
      registration: registration.data,
      me: meDoc.data,
      isAdmin,
      isRealAdmin: realAdmin,
      previewingAsPlayer: previewing,
      setPreviewAsPlayer,
      isMember,
      loadingMembership,
      signOut: () => signOut(fb().auth),
      config: configDoc.data ? mergeConfig(configDoc.data) : DEFAULT_CONFIG,
      state: stateDoc.data,
      stocks,
      stockById,
      players,
      playerById: new Map(players.map((p) => [p.uid, p])),
      holdings: holdingsQ.data,
      myHoldings: uid ? (byUid.get(uid) ?? []) : [],
      myShorts: uid ? openShortsQ.data.filter((s) => s.ownerId === uid) : [],
      photoOf: (id: string) => photoById.get(id),
    };
  }, [authLoading, user, uid, registration.data, meDoc.data, isAdmin, realAdmin, previewing, setPreviewAsPlayer, isMember, loadingMembership, configDoc.data, stateDoc.data, stocksQ.data, playersQ.data, holdingsQ.data, photosQ.data, openShortsQ.data]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
