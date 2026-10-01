import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";
import { getFirestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { mergeConfig, type GameConfig, type GameState, type Holding, type Player, type Stock } from "@fsm/shared";

/** Change to the region closest to your players (also update web/.env). */
export const REGION = "europe-west2";

// Friend-group scale: cap instances as a cost safety net.
setGlobalOptions({ region: REGION, maxInstances: 5 });

initializeApp();
export const db = getFirestore();

export const refs = {
  config: () => db.doc("config/global") as DocumentReference<Partial<GameConfig>>,
  state: () => db.doc("meta/state") as DocumentReference<GameState>,
  player: (uid: string) => db.doc(`players/${uid}`) as DocumentReference<Player>,
  stock: (id: string) => db.doc(`stocks/${id}`) as DocumentReference<Stock>,
  holding: (uid: string, stockId: string) => db.doc(`holdings/${uid}_${stockId}`) as DocumentReference<Holding>,
  registration: (uid: string) => db.doc(`registrations/${uid}`),
  admin: (uid: string) => db.doc(`admins/${uid}`),
  report: (week: number) => db.doc(`weeklyReports/week-${String(week).padStart(4, "0")}`),
};

export function initialState(now: number): GameState {
  return { currentWeek: 1, prizePool: 0, weekFees: 0, weekStartedAt: now, lastCloseAt: null };
}

export async function readConfig(tx: Transaction): Promise<GameConfig> {
  const snap = await tx.get(refs.config());
  return mergeConfig(snap.data());
}

export async function readState(tx: Transaction, now: number): Promise<{ state: GameState; exists: boolean }> {
  const snap = await tx.get(refs.state());
  return snap.exists ? { state: snap.data()!, exists: true } : { state: initialState(now), exists: false };
}

export function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
}

export async function isAdmin(uid: string): Promise<boolean> {
  return (await refs.admin(uid).get()).exists;
}

export async function requireAdmin(req: CallableRequest): Promise<string> {
  const uid = requireAuth(req);
  if (!(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admins only.");
  return uid;
}

export function auditRef() {
  return db.collection("auditLog").doc();
}

export function auditEntry(actorId: string, action: string, targetId: string | null, details: Record<string, unknown>, now: number) {
  return { actorId, action, targetId, details, createdAt: now };
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
export async function readWorld(tx: Transaction) {
  const [playersSnap, stocksSnap, holdingsSnap] = await Promise.all([
    tx.get(db.collection("players")),
    tx.get(db.collection("stocks")),
    tx.get(db.collection("holdings")),
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
