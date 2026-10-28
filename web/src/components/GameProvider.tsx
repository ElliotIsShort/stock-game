"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { collection, doc, limit, orderBy, query, where } from "firebase/firestore";
import {
  assignTickers,
  computeStandings,
  DEFAULT_CONFIG,
  mergeConfig,
  type AppNotification,
  type PriceAlert,
  type Recap,
  type SeenSnapshot,
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
  /** Leaderboard rank among active, non-idle players; null otherwise. */
  rank: number | null;
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
  /** A stock's ticker (stored, or the legacy default the server would assign). */
  tickerOf: (stockId: string) => string;
  /** Stocks, players, holdings and shorts have all loaded, so net worths and ranks are real. */
  marketReady: boolean;
  /** "While you were away", until dismissed (kept for the browser tab). */
  recap: Recap | null;
  dismissRecap: () => void;
  /** Your snapshot from the session before this tab opened (moments compare against it). */
  previousSession: SeenSnapshot | null;
  /** True once this tab's touch has answered (previousSession is settled). */
  sessionKnown: boolean;
  /** Your 20 most recent in-app notifications, newest first. */
  notifications: AppNotification[];
  /** Your active price alerts. */
  myAlerts: PriceAlert[];
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

  const notificationsQ = useQuery<AppNotification>(
    liveDb && uid ? query(collection(liveDb, "notifications"), where("uid", "==", uid), orderBy("createdAt", "desc"), limit(20)) : null,
    [on, uid],
  );
  const alertsQ = useQuery<PriceAlert>(
    liveDb && uid ? query(collection(liveDb, "alerts"), where("uid", "==", uid), where("status", "==", "active")) : null,
    [on, uid],
  );

  // Record activity once per page load. The recap and the previous-session
  // snapshot are kept in sessionStorage so a reload doesn't lose them (the
  // second touch would only see this session's snapshot).
  const [recap, setRecap] = useState<Recap | null>(null);
  const [previousSession, setPreviousSession] = useState<SeenSnapshot | null>(null);
  const [sessionKnown, setSessionKnown] = useState(false);
  const touched = useRef<string | null>(null);
  useEffect(() => {
    if (!meDoc.data || !uid || touched.current === uid) return;
    touched.current = uid;
    const recapKey = `fsm:recap:${uid}`;
    const prevKey = `fsm:previous:${uid}`;
    const storedRecap = sessionStorage.getItem(recapKey);
    if (storedRecap) setRecap(JSON.parse(storedRecap) as Recap);
    const storedPrev = sessionStorage.getItem(prevKey);
    if (storedPrev) {
      setPreviousSession(JSON.parse(storedPrev) as SeenSnapshot | null);
      setSessionKnown(true);
    }
    api
      .touch()
      .then((res) => {
        if (res.recap) {
          sessionStorage.setItem(recapKey, JSON.stringify(res.recap));
          setRecap(res.recap);
        }
        if (storedPrev === null) {
          sessionStorage.setItem(prevKey, JSON.stringify(res.previous));
          setPreviousSession(res.previous);
        }
      })
      .catch(() => undefined)
      .finally(() => setSessionKnown(true));
  }, [meDoc.data, uid]);
  const dismissRecap = useCallback(() => {
    if (uid) sessionStorage.removeItem(`fsm:recap:${uid}`);
    setRecap(null);
  }, [uid]);

  const marketReady = on && !stocksQ.loading && !playersQ.loading && !holdingsQ.loading && !openShortsQ.loading;

  const value = useMemo<GameContextValue>(() => {
    const stocks = stocksQ.data;
    const feePct = (configDoc.data ? mergeConfig(configDoc.data) : DEFAULT_CONFIG).tradingFeePct;
    const photoById = new Map(photosQ.data.map((p) => [p.uid, p.dataUrl]));
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const tickers = assignTickers(stocks);
    const byUid = new Map<string, Holding[]>();
    for (const h of holdingsQ.data) byUid.set(h.uid, [...(byUid.get(h.uid) ?? []), h]);
    // Same maths as the server's touch/recap: net worth less open-short liability, then rank.
    const standings = computeStandings(playersQ.data, stocks, holdingsQ.data, openShortsQ.data, feePct);
    const players: PlayerView[] = playersQ.data.map((p) => {
      const s = standings.get(p.uid)!;
      return { ...p, netWorth: s.netWorth, holdingsValue: s.holdingsValue, score: s.score, rank: s.rank };
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
      tickerOf: (id: string) => tickers.get(id) ?? "",
      marketReady,
      recap,
      dismissRecap,
      previousSession,
      sessionKnown,
      notifications: notificationsQ.data,
      myAlerts: alertsQ.data,
    };
  }, [authLoading, user, uid, registration.data, meDoc.data, isAdmin, realAdmin, previewing, setPreviewAsPlayer, isMember, loadingMembership, configDoc.data, stateDoc.data, stocksQ.data, playersQ.data, holdingsQ.data, photosQ.data, openShortsQ.data, marketReady, recap, dismissRecap, previousSession, sessionKnown, notificationsQ.data, alertsQ.data]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
