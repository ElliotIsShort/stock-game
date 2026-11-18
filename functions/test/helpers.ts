/**
 * Helpers for integration tests against the local Firebase emulators.
 * Everything here talks to 127.0.0.1 with the demo-fsm project, so it can
 * never touch the real Firebase project.
 */
import { SERVER_COLLECTIONS } from "@fsm/shared";

export const PROJECT = "demo-fsm";

/**
 * The server most tests play in (created by `setupPlayers`). Game paths passed
 * to getDoc/listDocs/patchDoc/clientRead/... are scoped to it automatically
 * (`players/x` -> `servers/<SERVER>/players/x`), and server-scoped callables get
 * `serverId` filled in, unless a test passes one explicitly (isolation tests do).
 */
export let SERVER = "";
export function setServer(id: string): void {
  SERVER = id;
}
const GAME_ROOTS = new Set<string>([...SERVER_COLLECTIONS, "private"]);
/** `players/x` -> `servers/<serverId>/players/x`; global paths (registrations, admins, servers/..., ...) are left alone. */
/** Pass `null` as the server to address the legacy top-level (pre-migration) layout. */
export function scoped(path: string, serverId: string | null = SERVER): string {
  return serverId !== null && GAME_ROOTS.has(path.split("/")[0]) ? `servers/${serverId}/${path}` : path;
}
const SERVER_FUNCTIONS = new Set([
  "trade", "openShort", "closeShort", "createPost", "toggleReaction", "deletePost", "touch", "setTicker", "setStockPhoto",
  "createAlert", "cancelAlert", "markNotificationsRead", "setDiscordId", "updateConfig", "delistPlayer", "runWeeklyClose",
  "setCloseTime", "renamePlayer", "updateContent", "resetGame", "testDiscord", "sendDiscordDigest", "approvePlayer",
  "addPlayerToServer", "setDiscordWebhook", "archiveServer", "unarchiveServer", "renameServer",
]);
const FN = `http://127.0.0.1:5001/${PROJECT}/europe-west2`;
const FS_ROOT = `http://127.0.0.1:8180/v1/projects/${PROJECT}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099";

export interface User {
  uid: string;
  token: string;
  email: string;
}

export class CallError extends Error {
  constructor(public status: string, message: string, public details?: any) {
    super(`${status}: ${message}`);
  }
}

/** Wipe every Firestore doc and every auth account in the emulators. */
export async function wipeEmulators(): Promise<void> {
  SERVER = "";
  const [a, b] = await Promise.all([
    fetch(`http://127.0.0.1:8180/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }),
    fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" }),
  ]);
  if (!a.ok || !b.ok) throw new Error("Couldn't wipe emulators. Are they running? Use `npm run test:integration`.");
}

let counter = 0;
export async function signUp(name = "user"): Promise<User> {
  const email = `${name.toLowerCase()}-${Date.now()}-${counter++}@example.com`;
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123", returnSecureToken: true }),
  });
  const j = (await r.json()) as { localId: string; idToken: string };
  return { uid: j.localId, token: j.idToken, email };
}

/** Invoke a callable function as `user` (or unauthenticated when null). */
export async function call<T = any>(user: User | null, name: string, data: unknown = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = `Bearer ${user.token}`;
  const body =
    SERVER_FUNCTIONS.has(name) && SERVER && data && typeof data === "object" && !Array.isArray(data) && (data as any).serverId === undefined
      ? { ...(data as object), serverId: SERVER }
      : data;
  const r = await fetch(`${FN}/${name}`, { method: "POST", headers, body: JSON.stringify({ data: body }) });
  const j = (await r.json()) as { result?: T; error?: { status: string; message: string; details?: unknown } };
  if (j.error) throw new CallError(j.error.status, j.error.message, j.error.details);
  return j.result as T;
}

/** Assert a callable fails with the given gRPC-style status, e.g. "PERMISSION_DENIED". */
export async function expectCallError(p: Promise<unknown>, status: string): Promise<CallError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CallError && e.status === status) return e;
    throw new Error(`Expected ${status}, got ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`Expected ${status}, but the call succeeded`);
}

/**
 * Run one tick of the per-minute `closeScheduler`. The emulator doesn't fire
 * scheduled functions on its own (no Cloud Scheduler), but a v2 scheduled
 * function is an HTTP handler, so the emulator's function route invokes it.
 */
export async function tickScheduler(): Promise<void> {
  // The emulator keys non-HTTPS triggers as "<name>-0".
  const r = await fetch(`${FN}/closeScheduler-0`, { method: "POST" });
  if (!r.ok) throw new Error(`closeScheduler tick failed: ${r.status} ${await r.text()}`);
}

// ---------- Firestore REST (admin access bypasses rules with "Bearer owner") ----------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function fromValue(v: any): Json {
  if ("doubleValue" in v) return v.doubleValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromValue(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  return v;
}

function toValue(v: Json): any {
  if (v === null) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
}

const OWNER = { authorization: "Bearer owner" };

export async function getDoc<T = any>(path: string, serverId?: string | null): Promise<T | null> {
  const r = await fetch(`${FS_ROOT}/${scoped(path, serverId)}`, { headers: OWNER });
  if (r.status === 404) return null;
  const j = (await r.json()) as { fields?: Record<string, unknown> };
  return (j.fields ? fromValue({ mapValue: { fields: j.fields } }) : {}) as T;
}

export async function listDocs<T = any>(collection: string, serverId?: string | null): Promise<T[]> {
  const r = await fetch(`${FS_ROOT}/${scoped(collection, serverId)}?pageSize=500`, { headers: OWNER });
  const j = (await r.json()) as { documents?: { fields?: Record<string, unknown> }[] };
  return (j.documents ?? []).map((d) => fromValue({ mapValue: { fields: d.fields ?? {} } }) as T);
}

/** Merge `fields` into a doc (creating it if needed), bypassing security rules. */
export async function patchDoc(path: string, fields: Record<string, Json>, serverId?: string | null): Promise<void> {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const r = await fetch(`${FS_ROOT}/${scoped(path, serverId)}${mask ? `?${mask}` : ""}`, {
    method: "PATCH",
    headers: { ...OWNER, "content-type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!r.ok) throw new Error(`patch ${path} failed: ${r.status} ${await r.text()}`);
}

/** Poll until `fn` returns something truthy (Firestore triggers run asynchronously). */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Remove fields from a doc (e.g. to simulate state from before a field existed), bypassing security rules. */
export async function clearFields(path: string, keys: string[], serverId?: string | null): Promise<void> {
  const mask = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const r = await fetch(`${FS_ROOT}/${scoped(path, serverId)}?${mask}&currentDocument.exists=true`, {
    method: "PATCH",
    headers: { ...OWNER, "content-type": "application/json" },
    body: JSON.stringify({ fields: {} }),
  });
  if (!r.ok) throw new Error(`clear ${path} failed: ${r.status} ${await r.text()}`);
}

/** Read a doc as a client would (security rules apply). Returns the HTTP status. */
export async function clientRead(user: User, path: string, serverId?: string | null): Promise<number> {
  return (await fetch(`${FS_ROOT}/${scoped(path, serverId)}`, { headers: { authorization: `Bearer ${user.token}` } })).status;
}

/** Try to write a doc as a client would (security rules apply). Returns the HTTP status. */
export async function clientWrite(user: User, path: string, fields: Record<string, Json>, serverId?: string | null): Promise<number> {
  const r = await fetch(`${FS_ROOT}/${scoped(path, serverId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
  });
  return r.status;
}

// ---------- Game setup ----------

export async function makeAdmin(user: User): Promise<void> {
  await patchDoc(`admins/${user.uid}`, {});
}

/** A close time comfortably in the future (createServer wants >= 5 minutes ahead). */
export const inDays = (n: number) => Date.now() + n * 86_400_000;

/**
 * Create a server as `admin` and make it the default test server. Returns its code.
 * Pass `switchTo: false` to create another one without changing the default.
 */
export async function makeServer(admin: User, name = "Test", opts: { closesAt?: number; copyConfigFrom?: string; switchTo?: boolean } = {}): Promise<string> {
  const res = await call<{ serverId: string }>(admin, "createServer", {
    name,
    closesAt: opts.closesAt ?? inDays(3),
    ...(opts.copyConfigFrom ? { copyConfigFrom: opts.copyConfigFrom } : {}),
  });
  if (opts.switchTo !== false) setServer(res.serverId);
  return res.serverId;
}

/** Sign up and register a user (no server yet). */
export async function registerUser(name: string): Promise<User> {
  const u = await signUp(name);
  await call(u, "register", { displayName: name });
  return u;
}

/**
 * Sign up, register and approve players into a fresh server (the default test
 * server). The first one is made admin, creates the server and approves everyone.
 */
export async function setupPlayers(...names: string[]): Promise<User[]> {
  const users: User[] = [];
  for (const name of names) users.push(await registerUser(name));
  await makeAdmin(users[0]);
  await makeServer(users[0]);
  for (const u of users) await call(users[0], "approvePlayer", { uid: u.uid });
  return users;
}

/** A tiny but valid-looking JPEG data URL (passes the magic-byte check). */
export function jpegDataUrl(extraBytes = 32): string {
  const bytes = Buffer.alloc(4 + extraBytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

/**
 * Set a server's close time the way an admin would: the state's `closesAt` and
 * the denormalised copy on the server doc the scheduler queries (kept in sync
 * by the functions; tests that patch the emulator directly must do both).
 */
export async function setClosesAt(at: number, serverId: string = SERVER, extraState: Record<string, Json> = {}): Promise<void> {
  await patchDoc("meta/state", { closesAt: at, ...extraState }, serverId);
  await patchDoc(`servers/${serverId}`, { closesAt: at });
}
