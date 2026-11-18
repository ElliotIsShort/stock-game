import { HttpsError } from "firebase-functions/v2/https";
import {
  DEFAULT_CONFIG,
  claimServerCode,
  closeTimeError,
  mergeConfig,
  type GameState,
  type ServerDoc,
} from "@fsm/shared";
import { asObject, auditEntry, auditRef, db, gameCall, gameCtx, parseServerId, refs, reqString, requireAdmin } from "./common";

const MAX_SERVER_NAME = 40;

function serverName(data: Record<string, unknown>): string {
  const name = reqString(data, "name", 200).replace(/\s+/g, " ");
  if (name.length < 2 || name.length > MAX_SERVER_NAME) {
    throw new HttpsError("invalid-argument", `Name must be 2–${MAX_SERVER_NAME} characters.`);
  }
  return name;
}

/**
 * Admin: create a new server (an independent game). The code is generated
 * here (6 digits, first non-zero), never chosen: the server document is
 * written with a create-only write, retrying with a new code on a collision.
 * Config is copied from `copyConfigFrom`, or DEFAULT_CONFIG when omitted. State
 * starts at week 1 with the admin's `closesAt`; the rules doc is empty and no
 * Discord webhook is set (nothing posts until the admin sets one).
 */
export const createServer = gameCall(async (req) => {
  const adminId = await requireAdmin(req);
  const data = asObject(req.data);
  const name = serverName(data);
  const closesAt = data.closesAt;
  const now = Date.now();
  const timeError = closeTimeError(closesAt, now);
  if (timeError) throw new HttpsError("invalid-argument", timeError);

  let config = { ...DEFAULT_CONFIG };
  let copiedFrom: string | null = null;
  if (data.copyConfigFrom !== undefined && data.copyConfigFrom !== null && data.copyConfigFrom !== "") {
    copiedFrom = parseServerId(data.copyConfigFrom);
    const source = refs(copiedFrom);
    if (!(await source.server().get()).exists) throw new HttpsError("not-found", "The server to copy settings from doesn't exist.");
    config = mergeConfig((await source.config().get()).data());
  }

  const state: GameState = { currentWeek: 1, prizePool: 0, weekFees: 0, weekStartedAt: now, lastCloseAt: null, closesAt: closesAt as number };
  const code = await claimServerCode(async (candidate) => {
    const R = refs(candidate);
    const server: ServerDoc = { slug: candidate, name, status: "active", createdAt: now, closesAt: closesAt as number, hasDiscordWebhook: false };
    const batch = db.batch();
    // create(): fails the whole batch if the id already exists, so a collision never overwrites a server.
    batch.create(R.server(), server);
    batch.set(R.config(), config);
    batch.set(R.state(), state);
    batch.set(R.content(), { rules: "", changelog: "", updatedAt: now });
    batch.set(auditRef(), auditEntry(adminId, "createServer", candidate, { name, copiedFrom, closesAt }, now, candidate));
    try {
      await batch.commit();
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 6) return false; // ALREADY_EXISTS
      throw err;
    }
  });
  return { serverId: code, name };
});

/** Admin: make a server read-only (mutations rejected, scheduler/digest/Discord skip it). */
export const archiveServer = gameCall(async (req) => setStatus(req, "archived"));

/** Admin: reopen an archived server. */
export const unarchiveServer = gameCall(async (req) => setStatus(req, "active"));

async function setStatus(req: Parameters<typeof gameCtx>[0], status: "active" | "archived") {
  // readOnly: allowed on archived servers (that's the point of unarchive).
  const { uid: adminId, serverId, R } = await gameCtx(req, { admin: true, readOnly: true });
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(R.server());
    if (snap.data()?.status === status) return;
    tx.update(R.server(), { status });
    tx.set(auditRef(), auditEntry(adminId, status === "archived" ? "archiveServer" : "unarchiveServer", serverId, {}, now, serverId));
  });
  return { serverId, status };
}

/** Admin: change a server's display name (the code never changes). */
export const renameServer = gameCall(async (req) => {
  const { uid: adminId, serverId, R, data } = await gameCtx(req, { admin: true, readOnly: true });
  const name = serverName(data);
  const now = Date.now();
  const from = await db.runTransaction(async (tx) => {
    const snap = await tx.get(R.server());
    const prev = snap.data()?.name ?? "";
    tx.update(R.server(), { name });
    tx.set(auditRef(), auditEntry(adminId, "renameServer", serverId, { from: prev, to: name }, now, serverId));
    return prev;
  });
  return { serverId, from, to: name };
});

