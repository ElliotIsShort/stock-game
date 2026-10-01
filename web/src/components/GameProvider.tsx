"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { collection, doc } from "firebase/firestore";
import {
  DEFAULT_CONFIG,
  leaderboardScore,
  mergeConfig,
  netWorth,
  type GameConfig,
  type GameState,
  type Holding,
  type Player,
  type Registration,
  type Stock,
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
  isAdmin: boolean;
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
}

const GameContext = createContext<GameContextValue | null>(null);

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

  const isAdmin = Boolean(adminDoc.data);
  const isMember = Boolean(meDoc.data) || isAdmin;
  const loadingMembership = registration.loading || adminDoc.loading || meDoc.loading;
  const liveDb = db && isMember ? db : null;
  const on = Boolean(liveDb);

  const stocksQ = useQuery<Stock>(liveDb ? collection(liveDb, "stocks") : null, [on]);
  const playersQ = useQuery<Player>(liveDb ? collection(liveDb, "players") : null, [on]);
  const holdingsQ = useQuery<Holding>(liveDb ? collection(liveDb, "holdings") : null, [on]);
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
    const players: PlayerView[] = playersQ.data.map((p) => {
      const nw = netWorth(p.cash, byUid.get(p.uid) ?? [], priceOf);
      return {
        ...p,
        netWorth: nw,
        holdingsValue: nw - p.cash,
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
    };
  }, [authLoading, user, uid, registration.data, meDoc.data, isAdmin, isMember, loadingMembership, configDoc.data, stateDoc.data, stocksQ.data, playersQ.data, holdingsQ.data]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
