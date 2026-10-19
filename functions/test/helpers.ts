/**
 * Helpers for integration tests against the local Firebase emulators.
 * Everything here talks to 127.0.0.1 with the demo-fsm project, so it can
 * never touch the real Firebase project.
 */
import { readFileSync } from "node:fs";

export const PROJECT = "demo-fsm";
const FN = `http://127.0.0.1:5001/${PROJECT}/europe-west2`;
const FS_ROOT = `http://127.0.0.1:8180/v1/projects/${PROJECT}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099";

export interface User {
  uid: string;
  token: string;
  email: string;
}

export class CallError extends Error {
  constructor(public status: string, message: string) {
    super(`${status}: ${message}`);
  }
}

/** Wipe every Firestore doc and every auth account in the emulators. */
export async function wipeEmulators(): Promise<void> {
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
  const r = await fetch(`${FN}/${name}`, { method: "POST", headers, body: JSON.stringify({ data }) });
  const j = (await r.json()) as { result?: T; error?: { status: string; message: string } };
  if (j.error) throw new CallError(j.error.status, j.error.message);
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

export function cronSecret(): string {
  const file = readFileSync(new URL("../.secret.local", import.meta.url), "utf8");
  const m = /^CRON_SECRET=(.+)$/m.exec(file);
  if (!m) throw new Error("functions/.secret.local has no CRON_SECRET");
  return m[1].trim();
}

export function cron(secret: string | null, method = "POST") {
  const headers: Record<string, string> = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return fetch(`${FN}/weeklyCloseCron`, { method, headers });
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

export async function getDoc<T = any>(path: string): Promise<T | null> {
  const r = await fetch(`${FS_ROOT}/${path}`, { headers: OWNER });
  if (r.status === 404) return null;
  const j = (await r.json()) as { fields?: Record<string, unknown> };
  return (j.fields ? fromValue({ mapValue: { fields: j.fields } }) : {}) as T;
}

export async function listDocs<T = any>(collection: string): Promise<T[]> {
  const r = await fetch(`${FS_ROOT}/${collection}?pageSize=500`, { headers: OWNER });
  const j = (await r.json()) as { documents?: { fields?: Record<string, unknown> }[] };
  return (j.documents ?? []).map((d) => fromValue({ mapValue: { fields: d.fields ?? {} } }) as T);
}

/** Merge `fields` into a doc (creating it if needed), bypassing security rules. */
export async function patchDoc(path: string, fields: Record<string, Json>): Promise<void> {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const r = await fetch(`${FS_ROOT}/${path}${mask ? `?${mask}` : ""}`, {
    method: "PATCH",
    headers: { ...OWNER, "content-type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!r.ok) throw new Error(`patch ${path} failed: ${r.status} ${await r.text()}`);
}

/** Read a doc as a client would (security rules apply). Returns the HTTP status. */
export async function clientRead(user: User, path: string): Promise<number> {
  return (await fetch(`${FS_ROOT}/${path}`, { headers: { authorization: `Bearer ${user.token}` } })).status;
}

/** Try to write a doc as a client would (security rules apply). Returns the HTTP status. */
export async function clientWrite(user: User, path: string, fields: Record<string, Json>): Promise<number> {
  const r = await fetch(`${FS_ROOT}/${path}`, {
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

/** Sign up, register and approve players. The first one is made admin and approves everyone. */
export async function setupPlayers(...names: string[]): Promise<User[]> {
  const users: User[] = [];
  for (const name of names) {
    const u = await signUp(name);
    await call(u, "register", { displayName: name });
    users.push(u);
  }
  await makeAdmin(users[0]);
  for (const u of users) await call(users[0], "approvePlayer", { uid: u.uid });
  return users;
}

/** A tiny but valid-looking JPEG data URL (passes the magic-byte check). */
export function jpegDataUrl(extraBytes = 32): string {
  const bytes = Buffer.alloc(4 + extraBytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
