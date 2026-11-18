import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";
import { getFirestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableOptions, type CallableRequest } from "firebase-functions/v2/https";
import { effectiveClosesAt, isServerCode, legacyClosesAt, mergeConfig, seriesDocId, type GameConfig, type GameState, type Holding, type NetWorthHistory, type NetWorthSeries, type Player, type ServerDoc, type Short, type Stock } from "@fsm/shared";

/** Change to the region closest to your players (also update web/.env). */
export const REGION = "europe-west2";

// Friend-group scale: cap instances as a cost safety net.
setGlobalOptions({ region: REGION, maxInstances: 5 });

initializeApp();
export const db = getFirestore();

/** Refs for the global (cross-server) collections. */
export const globalRefs = {
  registration: (uid: string) => db.doc(`registrations/${uid}`),
  admin: (uid: string) => db.doc(`admins/${uid}`),
  user: (uid: string) => db.doc(`users/${uid}`),
  server: (serverId: string) => db.doc(`servers/${serverId}`) as DocumentReference<ServerDoc>,
  servers: () => db.collection("servers"),
};

/**
 * Typed refs for ONE server's data. Every game read/write goes through this,
 * so nothing can reach another server by accident. `col`/`doc` take paths
 * relative to the server root.
 */
export function refs(serverId: string) {
  const root = `servers/${serverId}`;
  const doc = (path: string) => db.doc(`${root}/${path}`);
  const col = (name: string) => db.collection(`${root}/${name}`);
  return {
    serverId,
    root,
    server: () => db.doc(root) as DocumentReference<ServerDoc>,
    doc,
    col,
    config: () => doc("config/global") as DocumentReference<Partial<GameConfig>>,
    content: () => doc("content/global"),
    state: () => doc("meta/state") as DocumentReference<GameState>,
    player: (uid: string) => doc(`players/${uid}`) as DocumentReference<Player>,
    stock: (id: string) => doc(`stocks/${id}`) as DocumentReference<Stock>,
    holding: (uid: string, stockId: string) => doc(`holdings/${uid}_${stockId}`) as DocumentReference<Holding>,
    photo: (uid: string) => doc(`photos/${uid}`),
    netWorthHistory: (uid: string) => doc(`netWorthHistory/${uid}`) as DocumentReference<NetWorthHistory>,
    series: (uid: string, week: number) => doc(`netWorthSeries/${seriesDocId(uid, week)}`) as DocumentReference<NetWorthSeries>,
    short: (id: string) => doc(`shorts/${id}`) as DocumentReference<Short>,
    report: (week: number) => doc(`weeklyReports/week-${String(week).padStart(4, "0")}`),
    outbox: () => col("discordOutbox"),
    discordRate: () => doc("discordState/rate"),
    privateDiscord: () => doc("private/discord"),
  };
}
export type Refs = ReturnType<typeof refs>;

export function initialState(now: number): GameState {
  return { currentWeek: 1, prizePool: 0, weekFees: 0, weekStartedAt: now, lastCloseAt: null, closesAt: legacyClosesAt(now, null) };
}

/**
 * Migration: state written before `closesAt` existed gets it derived once
 * from the old schedule (next Sunday 20:00 UTC) and persisted. Returns the
 * close time. One read; one write only the first time.
 */
export async function ensureClosesAt(R: Refs, now: number): Promise<number | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(R.state());
    if (!snap.exists) return null;
    const state = snap.data()!;
    if (typeof state.closesAt === "number") return state.closesAt;
    const closesAt = effectiveClosesAt(state, now);
    tx.update(R.state(), { closesAt });
    tx.update(R.server(), { closesAt });
    return closesAt;
  });
}

export async function readConfig(tx: Transaction, R: Refs): Promise<GameConfig> {
  const snap = await tx.get(R.config());
  return mergeConfig(snap.data());
}

export async function readState(tx: Transaction, R: Refs, now: number): Promise<{ state: GameState; exists: boolean }> {
  const snap = await tx.get(R.state());
  return snap.exists ? { state: snap.data()!, exists: true } : { state: initialState(now), exists: false };
}

// ---------- Maintenance mode (global kill switch) ----------

/** `system/maintenance` { enabled }. Absent or enabled:false = the game is open. */
export const MAINTENANCE_MESSAGE = "The game is being upgraded, back shortly.";

export async function inMaintenance(): Promise<boolean> {
  const snap = await db.doc("system/maintenance").get();
  return snap.exists && snap.data()?.enabled === true;
}

export async function assertNotMaintenance(): Promise<void> {
  if (await inMaintenance()) throw new HttpsError("unavailable", MAINTENANCE_MESSAGE);
}

type CallHandler<T, R> = (req: CallableRequest<T>) => Promise<R> | R;

/**
 * `onCall` for every function that can change data: rejects signed-in calls
 * while maintenance mode is on (one read). Unauthenticated calls fall through
 * so the handler's own "Sign in first" error still wins. Only `setMaintenance`
 * (the switch itself) uses plain `onCall`.
 */
export function gameCall<T = any, R = any>(a: CallableOptions<T> | CallHandler<T, R>, b?: CallHandler<T, R>) {
  const opts: CallableOptions<T> = typeof a === "function" ? {} : a;
  const handler = (typeof a === "function" ? a : b)!;
  return onCall<T, Promise<R>>(opts, async (req) => {
    if (req.auth) await assertNotMaintenance();
    return handler(req);
  });
}

export function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
}

export async function isAdmin(uid: string): Promise<boolean> {
  return (await globalRefs.admin(uid).get()).exists;
}

export async function requireAdmin(req: CallableRequest): Promise<string> {
  const uid = requireAuth(req);
  if (!(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admins only.");
  return uid;
}

export function auditRef() {
  return db.collection("auditLog").doc();
}

export function auditEntry(actorId: string, action: string, targetId: string | null, details: Record<string, unknown>, now: number, serverId?: string) {
  return { actorId, action, targetId, details, createdAt: now, ...(serverId ? { serverId } : {}) };
}

export function asObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpsError("invalid-argument", "Expected an object.");
  return data as Record<string, unknown>;
}

export function reqString(obj: Record<string, unknown>, key: string, maxLen = 200): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0 || v.length > maxLen) {
    throw new HttpsError("invalid-argument", `${key} must be a non-empty string.`);
  }
  return v.trim();
}

export function optString(obj: Record<string, unknown>, key: string, maxLen = 200): string | null {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > maxLen) throw new HttpsError("invalid-argument", `${key} must be a string.`);
  return v.trim() || null;
}

export function reqNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpsError("invalid-argument", `${key} must be a number.`);
  return v;
}

/** Load every player, stock and holding. Fine at friend-group scale (tens of docs). */
export async function readWorld(tx: Transaction, R: Refs) {
  const [playersSnap, stocksSnap, holdingsSnap] = await Promise.all([
    tx.get(R.col("players")),
    tx.get(R.col("stocks")),
    tx.get(R.col("holdings")),
  ]);
  const players = playersSnap.docs.map((d) => d.data() as Player);
  const stocks = stocksSnap.docs.map((d) => d.data() as Stock);
  const holdings = holdingsSnap.docs.map((d) => d.data() as Holding);
  return { players, stocks, holdings };
}

export function holdingsByUid(holdings: Holding[]): Map<string, Holding[]> {
  const map = new Map<string, Holding[]>();
  for (const h of holdings) {
    const list = map.get(h.uid) ?? [];
    list.push(h);
    map.set(h.uid, list);
  }
  return map;
}

// ---------- Servers ----------

/** Validate an incoming `serverId` against the code format (never trust it as a path otherwise). */
export function parseServerId(value: unknown): string {
  if (!isServerCode(value)) throw new HttpsError("invalid-argument", "Invalid serverId.");
  return value;
}

/**
 * The server must exist. Mutations also need it active (archived = read-only)
 * and not in per-server maintenance. Messages avoid the word "server": players
 * must never learn there is more than one.
 */
export async function requireServer(serverId: string, opts: { mutating?: boolean } = {}): Promise<ServerDoc> {
  const snap = await globalRefs.server(serverId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Game not found.");
  const server = snap.data()!;
  if (opts.mutating !== false) {
    if (server.status !== "active") throw new HttpsError("failed-precondition", "This game has ended and is read-only.");
    if (server.maintenance) throw new HttpsError("unavailable", MAINTENANCE_MESSAGE);
  }
  return server;
}

/** The caller has a player doc in this server (membership is defined by that doc, never by `users`). */
export async function requireMember(serverId: string, uid: string): Promise<void> {
  if (!(await refs(serverId).player(uid).get()).exists) throw new HttpsError("permission-denied", "You're not part of this game.");
}

export interface GameCtx {
  uid: string;
  serverId: string;
  R: Refs;
  admin: boolean;
  data: Record<string, unknown>;
}

/**
 * Standard preamble for server-scoped callables: signed in, valid `serverId`,
 * server exists (and is active for mutations), then either an admin check or
 * a membership check. Admins may act in any server.
 */
export async function gameCtx(
  req: CallableRequest,
  opts: { admin?: boolean; allowAdmin?: boolean; readOnly?: boolean } = {},
): Promise<GameCtx> {
  const uid = requireAuth(req);
  const data = asObject(req.data);
  const serverId = parseServerId(data.serverId);
  // Authorise BEFORE looking the server up, so a stranger can't probe which codes exist:
  // everyone who isn't allowed in gets the same "not part of this game" answer.
  const admin = await isAdmin(uid);
  if (opts.admin) {
    if (!admin) throw new HttpsError("permission-denied", "Admins only.");
  } else if (!(opts.allowAdmin && admin)) {
    await requireMember(serverId, uid);
  }
  await requireServer(serverId, { mutating: !opts.readOnly });
  return { uid, serverId, R: refs(serverId), admin, data };
}
