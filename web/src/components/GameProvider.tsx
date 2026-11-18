"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { collection, doc, limit, orderBy, query, where } from "firebase/firestore";
import {
  assignTickers,
  computeStandings,
  DEFAULT_CONFIG,
  mergeConfig,
  serverPaths,
  type AppNotification,
  type Landing,
  type PriceAlert,
  type Recap,
  type SeenSnapshot,
  type GameConfig,
  type GameState,
  type Holding,
  type Player,
  type Registration,
  type ServerDoc,
  type Short,
  type Stock,
  type StockPhoto,
} from "@fsm/shared";
import { fb, firebaseConfigured } from "@/lib/firebase";
import { storageKey } from "@/lib/serverStore";
import { useDoc, useQuery } from "@/lib/hooks";
import { api, setApiServer } from "@/lib/api";
import { useServer } from "./ServerProvider";

export interface PlayerView extends Player {
  netWorth: number;
  score: number;
  holdingsValue: number;
  /** Leaderboard rank among active, non-idle players; null otherwise. */
  rank: number | null;
}

export interface GameContextValue {
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
  /** The server (game) being viewed, or null when none is resolved (picker, or not a member of anything). */
  serverId: string | null;
  /** Display name, status and so on: only ever shown to people in two or more servers (and the admin). */
  server: ServerDoc | null;
  /** All paths for this server's collections (`serverPaths`); null without a server. */
  paths: ReturnType<typeof serverPaths> | null;
  /** Two or more memberships: the only users who may see anything server-related. */
  showServerUi: boolean;
  memberships: string[];
  landing: Landing;
  switchServer: (id: string) => void;
  /** Admin kill switch is on: every mutation is refused (the game is being upgraded). */
  maintenance: boolean;
}

export const GameContext = createContext<GameContextValue | null>(null);

/** This server's collection paths. Only call under a resolved server (all game pages are). */
export function usePaths(): ReturnType<typeof serverPaths> {
  const { paths } = useGame();
  if (!paths) throw new Error("usePaths needs a resolved server");
  return paths;
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used inside GameProvider");
  return ctx;
}

/**
 * Game data for ONE server. Remounted (keyed by server id) whenever the server
 * changes, so every subscription is torn down and re-created and no cached
 * state from one server can ever render under another.
 */
export function GameProvider({ children, serverId }: { children: ReactNode; serverId: string | null }) {
  const sv = useServer();
  const { user, authLoading, registration, isRealAdmin: realAdmin } = sv;
  // Set during render (not an effect): children's effects run before their parent's.
  setApiServer(serverId);
  const paths = useMemo(() => (serverId ? serverPaths(serverId) : null), [serverId]);

  const uid = user?.uid ?? null;
  // Never initialise Firebase during the static build's prerender.
  const db = firebaseConfigured && typeof window !== "undefined" ? fb().db : null;
  const meDoc = useDoc<Player>(db && uid && paths ? doc(db, paths.player(uid)) : null, [uid, serverId]);
  const serverDoc = useDoc<ServerDoc>(db && uid && paths ? doc(db, paths.root) : null, [uid, serverId]);

  // "View as player": admins can hide every admin affordance to see what players see.
  // UI-only — the server still treats them as an admin. Remembered for the browser tab, per server.
  const [previewAsPlayer, setPreviewState] = useState(false);
  useEffect(() => {
    setPreviewState(serverId ? sessionStorage.getItem(storageKey.viewAsPlayer(serverId)) === "1" : false);
  }, [serverId]);
  const setPreviewAsPlayer = useCallback(
    (on: boolean) => {
      if (serverId) {
        if (on) sessionStorage.setItem(storageKey.viewAsPlayer(serverId), "1");
        else sessionStorage.removeItem(storageKey.viewAsPlayer(serverId));
      }
      setPreviewState(on);
    },
    [serverId],
  );
  const previewing = realAdmin && previewAsPlayer;
  const isAdmin = realAdmin && !previewing;
  // An admin with no player account previews what a not-yet-approved signup sees.
  const isMember = serverId !== null && (Boolean(meDoc.data) || isAdmin);
  const loadingMembership = sv.loading || meDoc.loading;
  const liveDb = db && paths && isMember ? db : null;
  const on = Boolean(liveDb);

  const maintenanceDoc = useDoc<{ enabled?: boolean }>(db && uid ? doc(db, "system", "maintenance") : null, [uid]);

  const stocksQ = useQuery<Stock>(liveDb ? collection(liveDb, paths!.stocks) : null, [on, serverId]);
  const playersQ = useQuery<Player>(liveDb ? collection(liveDb, paths!.players) : null, [on, serverId]);
  const holdingsQ = useQuery<Holding>(liveDb ? collection(liveDb, paths!.holdings) : null, [on, serverId]);
  const photosQ = useQuery<StockPhoto>(liveDb ? collection(liveDb, paths!.photos) : null, [on, serverId]);
  // All open shorts: needed so the leaderboard can offset everyone's net worth,
  // not just the signed-in player's. Members may read all shorts.
  const openShortsQ = useQuery<Short>(
    liveDb ? query(collection(liveDb, paths!.shorts), where("status", "==", "open")) : null,
    [on, serverId],
  );
  const stateDoc = useDoc<GameState>(liveDb ? doc(liveDb, paths!.state) : null, [on, serverId]);
  const configDoc = useDoc<Partial<GameConfig>>(liveDb ? doc(liveDb, paths!.config) : null, [on, serverId]);

  const notificationsQ = useQuery<AppNotification>(
    liveDb && uid ? query(collection(liveDb, paths!.notifications), where("uid", "==", uid), orderBy("createdAt", "desc"), limit(20)) : null,
    [on, serverId, uid],
  );
  const alertsQ = useQuery<PriceAlert>(
    liveDb && uid ? query(collection(liveDb, paths!.alerts), where("uid", "==", uid), where("status", "==", "active")) : null,
    [on, serverId, uid],
  );

  // Record activity once per page load. The recap and the previous-session
  // snapshot are kept in sessionStorage so a reload doesn't lose them (the
  // second touch would only see this session's snapshot).
  const [recap, setRecap] = useState<Recap | null>(null);
  const [previousSession, setPreviousSession] = useState<SeenSnapshot | null>(null);
  const [sessionKnown, setSessionKnown] = useState(false);
  const touched = useRef<string | null>(null);
  useEffect(() => {
    if (!meDoc.data || !uid || !serverId || touched.current === uid) return;
    touched.current = uid;
    const recapKey = storageKey.recap(serverId, uid);
    const prevKey = storageKey.previous(serverId, uid);
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
  }, [meDoc.data, uid, serverId]);
  const dismissRecap = useCallback(() => {
    if (uid && serverId) sessionStorage.removeItem(storageKey.recap(serverId, uid));
    setRecap(null);
  }, [uid, serverId]);

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
      registration,
      me: meDoc.data,
      isAdmin,
      isRealAdmin: realAdmin,
      previewingAsPlayer: previewing,
      setPreviewAsPlayer,
      isMember,
      loadingMembership,
      signOut: sv.signOut,
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
      serverId,
      server: serverDoc.data,
      paths,
      showServerUi: sv.showServerUi,
      memberships: sv.memberships,
      landing: sv.landing,
      switchServer: sv.switchServer,
      maintenance: maintenanceDoc.data?.enabled === true,
    };
  }, [authLoading, user, uid, registration, sv.signOut, serverId, serverDoc.data, paths, sv.showServerUi, sv.memberships, sv.landing, sv.switchServer, meDoc.data, isAdmin, realAdmin, previewing, setPreviewAsPlayer, isMember, loadingMembership, configDoc.data, stateDoc.data, stocksQ.data, playersQ.data, holdingsQ.data, photosQ.data, openShortsQ.data, marketReady, recap, dismissRecap, previousSession, sessionKnown, notificationsQ.data, alertsQ.data, maintenanceDoc.data]);

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
