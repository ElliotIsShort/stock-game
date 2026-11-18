import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
// @ts-expect-error: a plain .mjs script, intentionally not part of any TypeScript project
import { COPIED, connect, migrate } from "../../scripts/migrate-to-servers.mjs";
// @ts-expect-error: a plain .mjs script
import { confirmationPhrase, deleteLegacy } from "../../scripts/delete-legacy.mjs";
import { SERVER_CODE_RE } from "@fsm/shared";
import { call, getDoc, signUp, wipeEmulators, type User } from "./helpers";

/**
 * The migration runs against the emulator with the Admin SDK (which bypasses
 * rules, like the real script). Legacy-shaped data is seeded at the top level.
 */
const PROJECT = "demo-fsm";
let db: Firestore;
let backupDir: string;
const quiet = () => undefined;
const HOUR = 3_600_000;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8180";
  db = connect(PROJECT);
});
afterAll(() => {
  rmSync(backupDir ?? "", { recursive: true, force: true });
});

let alice: User;
let bob: User;
let cara: User;

/** Three real accounts (so functions can act as them afterwards) with legacy-shaped, interlinked data. */
async function seedLegacy(opts: { closesAt?: number; maintenance?: boolean } = {}) {
  const now = Date.now();
  [alice, bob, cara] = [await signUp("Alice"), await signUp("Bob"), await signUp("Cara")];
  const people = [
    [alice, "Alice", 1234.56],
    [bob, "Bob", 987.65],
    [cara, "Cara", 1500],
  ] as const;
  const batch = db.batch();
  const doc = (path: string, data: object) => batch.set(db.doc(path), data);
  doc("config/global", { weeklyAllowance: 250, tradingFeePct: 0.02, prizeSplitPct: [0.5, 0.3, 0.2] });
  doc("content/global", { rules: "# Our rules\n\n- be nice", changelog: "", updatedAt: now - 5 });
  doc("meta/state", { currentWeek: 4, prizePool: 37.25, weekFees: 3.5, weekStartedAt: now - 2 * 86_400_000, lastCloseAt: now - 3 * 86_400_000, closesAt: opts.closesAt ?? now + 5 * 86_400_000, avgNetWorth: 1240.5 });
  for (const [u, name, cash] of people) {
    doc(`players/${u.uid}`, {
      uid: u.uid, displayName: name, cash, joinWeek: 1, isActive: true, isIdle: false, lastActiveAt: now - 1000, createdAt: now - 9e8,
      startingCash: 1000, totalAllowances: 600, totalBonus: 1.25, netWorthWeekStart: 1100, ...(name === "Bob" ? { discordId: "123456789012345678" } : {}),
    });
    const price = name === "Alice" ? 61.3 : name === "Bob" ? 44.1 : 52.8;
    doc(`stocks/${u.uid}`, {
      id: u.uid, ownerId: u.uid, displayName: name, price, poolCash: 1500 + price, poolShares: 30, k: (1500 + price) * 30, listed: true, listPrice: 50,
      listedAt: now - 9e8, listedWeek: 1, weekOpenPrice: 50, weekHigh: price + 2, weekLow: price - 2, weekTradeCount: 3, ticker: name.slice(0, 3).toUpperCase(),
      lastTrade: { by: bob.uid, at: now - 5000, week: 4 },
    });
    doc(`netWorthHistory/${u.uid}`, { uid: u.uid, points: [{ week: 1, t: now - 3e8, v: 1010 }, { week: 2, t: now - 2e8, v: 1090.5 }] });
    doc(`netWorthSeries/${u.uid}_4`, { uid: u.uid, week: 4, points: [{ t: now - 4000, v: 1111.11 }], openSince: now - 1e5, updatedAt: now - 4000 });
    doc(`photos/${u.uid}`, { uid: u.uid, dataUrl: "data:image/jpeg;base64,/9j/4AAQ", updatedAt: now - 7 });
  }
  doc(`holdings/${bob.uid}_${alice.uid}`, { uid: bob.uid, stockId: alice.uid, shares: 4.5, updatedAt: now - 100, costBasis: 55.5, holdingSince: now - 5e6 });
  doc(`holdings/${cara.uid}_${alice.uid}`, { uid: cara.uid, stockId: alice.uid, shares: 1.25, updatedAt: now - 200, costBasis: 51, holdingSince: now - 6e6 });
  doc("shorts/short-1", { id: "short-1", ownerId: cara.uid, ownerName: "Cara", stockId: bob.uid, stockName: "Bob", shares: 2, status: "open", openPrice: 45, openProceeds: 88.2, openedAt: now - 9e5, openWeek: 4, borrowFeesPaid: 0 });
  doc("trades/trade-1", { id: "trade-1", traderId: bob.uid, traderName: "Bob", stockId: alice.uid, stockName: "Alice", side: "buy", cashAmount: 250, netCash: -250, shares: 4.5, fee: 3.75, priceBefore: 55, priceAfter: 61.3, week: 4, createdAt: now - 8e5, linkedPostId: "post-1" });
  doc("posts/post-1", { id: "post-1", authorId: bob.uid, authorName: "Bob", taggedStockId: alice.uid, taggedName: "Alice", text: "Alice to the moon", linkedTradeId: "trade-1", linkedTradeSummary: "Bob bought 4.50 shares of Alice (£250.00)", reactions: { like: [cara.uid] }, reactionCount: 1, system: false, week: 4, createdAt: now - 8e5 });
  doc("alerts/alert-1", { id: "alert-1", uid: cara.uid, stockId: alice.uid, stockName: "Alice", direction: "above", price: 70, discord: false, status: "active", createdAt: now - 3e5 });
  doc("notifications/note-1", { id: "note-1", uid: cara.uid, kind: "alert", title: "🔔", body: "hi", stockId: alice.uid, createdAt: now - 2e5, read: false });
  doc("discordOutbox/out-1", { id: "out-1", priority: "normal", kind: "bigTrade", message: { title: "Big buy" }, status: "sent", createdAt: now - 8e5, sentAt: now - 7e5 });
  doc("discordState/rate", { windowStart: now - 1e6, sent: 3 });
  doc("weeklyReports/week-0003", { id: "week-0003", week: 3, periodEnd: now - 3 * 86_400_000, markdown: "# Week 3", highlights: { winners: [] }, trigger: "schedule" });
  // Global collections that must stay exactly where they are.
  doc(`registrations/${alice.uid}`, { uid: alice.uid, displayName: "Alice", email: "a@example.com", status: "approved", createdAt: now - 9e8, displayNameLower: "alice" });
  doc(`admins/${alice.uid}`, {});
  doc("devlog/entry-1", { id: "devlog-1", title: "Hello", body: "world", date: now, createdAt: now, updatedAt: now });
  doc("auditLog/audit-1", { actorId: alice.uid, action: "updateConfig", targetId: "config/global", details: {}, createdAt: now - 1e6 });
  if (opts.maintenance !== false) doc("system/maintenance", { enabled: true, updatedAt: now });
  await batch.commit();
}

/** Every doc under a top-level collection, id → data. */
async function snapshot(path: string): Promise<Map<string, unknown>> {
  const snap = await db.collection(path).get();
  return new Map(snap.docs.map((d) => [d.id, d.data()]));
}
const legacySnapshot = async () => Object.fromEntries(await Promise.all([...COPIED, "registrations", "admins", "devlog", "auditLog"].map(async (c: string) => [c, await snapshot(c)])));

beforeEach(async () => {
  await wipeEmulators();
  backupDir = mkdtempSync(join(tmpdir(), "fsm-backup-"));
  rmSync(backupDir, { recursive: true, force: true }); // the script creates it
});

/** Wait until the net-worth trigger has recorded this trade's points (and the margin re-check after them has had time to run). */
async function settleTriggers(serverId: string, since: number, uids: string[]): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const docs = await Promise.all(uids.map((u) => db.doc(`servers/${serverId}/netWorthSeries/${u}_4`).get()));
    if (docs.every((d) => (d.data()?.updatedAt ?? 0) >= since)) {
      await new Promise((r) => setTimeout(r, 600));
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Triggers didn't settle");
}

const run = (extra: Record<string, unknown> = {}) => migrate({ db, project: PROJECT, name: "DYF", backupDir, log: quiet, ...extra });

describe("dry run", () => {
  it("reports the plan and the code it would use, and writes nothing at all", async () => {
    await seedLegacy();
    const before = await legacySnapshot();
    const lines: string[] = [];
    const res = await run({ log: (l: string) => lines.push(l) });
    expect(res.dryRun).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.serverId).toMatch(SERVER_CODE_RE);
    expect(lines.join("\n")).toContain(res.serverId);
    expect(lines.join("\n")).toMatch(/players\s+3 legacy → create 3/);
    expect((await db.collection("servers").get()).size).toBe(0);
    expect((await db.collection("users").get()).size).toBe(0);
    expect(existsSync(backupDir)).toBe(false);
    expect(await legacySnapshot()).toEqual(before);
    // The real run uses the very same code.
    const real = await run({ execute: true });
    expect(real.serverId).toBe(res.serverId);
  });

  it("reports unmet prerequisites (and still writes nothing)", async () => {
    await seedLegacy({ maintenance: false });
    const res = await run();
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toContain("Maintenance mode is off");
    expect((await db.collection("servers").get()).size).toBe(0);
  });
});

describe("refusals", () => {
  it("won't run without maintenance mode, before writing anything", async () => {
    await seedLegacy({ maintenance: false });
    await expect(run({ execute: true })).rejects.toThrow(/Maintenance mode is off/);
    expect((await db.collection("servers").get()).size).toBe(0);
    expect((await db.collection("users").get()).size).toBe(0);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("won't run when maintenance is explicitly off, or when the weekly close is within two hours", async () => {
    await seedLegacy({ closesAt: Date.now() + HOUR });
    await expect(run({ execute: true })).rejects.toThrow(/within 2 hours/);
    await db.doc("meta/state").update({ closesAt: Date.now() + 3 * HOUR });
    await db.doc("system/maintenance").set({ enabled: false });
    await expect(run({ execute: true })).rejects.toThrow(/Maintenance mode is off/);
    expect((await db.collection("servers").get()).size).toBe(0);
  });

  it("needs a name and, to execute, a backup directory", async () => {
    await seedLegacy();
    await expect(migrate({ db, project: PROJECT, name: "", log: quiet })).rejects.toThrow(/--name/);
    await expect(migrate({ db, project: PROJECT, name: "DYF", execute: true, log: quiet })).rejects.toThrow(/--backup-dir/);
  });
});

describe("migrating for real", () => {
  it("copies every collection with ids and fields unchanged, leaves the legacy data alone, and verifies PASS", async () => {
    await seedLegacy();
    const before = await legacySnapshot();
    const res = await run({ execute: true });
    expect(res.ok, res.problems.join("; ")).toBe(true);
    const id = res.serverId as string;
    expect(id).toMatch(SERVER_CODE_RE);

    // Counts and contents, collection by collection, ids preserved.
    for (const c of COPIED as string[]) {
      const copied = await snapshot(`servers/${id}/${c}`);
      expect([...copied.keys()].sort(), c).toEqual([...(before[c] as Map<string, unknown>).keys()].sort());
      for (const [docId, data] of before[c] as Map<string, unknown>) expect(copied.get(docId), `${c}/${docId}`).toEqual(data);
    }
    // Interlinked references survive verbatim.
    expect(await getDoc("trades/trade-1", id)).toMatchObject({ linkedPostId: "post-1", stockId: alice.uid });
    expect(await getDoc("posts/post-1", id)).toMatchObject({ linkedTradeId: "trade-1", taggedStockId: alice.uid });
    expect(await getDoc(`holdings/${bob.uid}_${alice.uid}`, id)).toMatchObject({ uid: bob.uid, stockId: alice.uid, shares: 4.5 });
    expect(await getDoc("meta/state", id)).toMatchObject({ currentWeek: 4, prizePool: 37.25 });

    // Totals.
    expect(res.totals.after).toEqual(res.totals.before);
    expect(res.totals.before.playersCash).toBeCloseTo(1234.56 + 987.65 + 1500, 9);
    expect(res.totals.before.currentWeek).toBe(4);

    // The server document and the users lookup.
    const server = await getDoc(`servers/${id}`);
    expect(server).toMatchObject({ slug: id, name: "DYF", status: "active", hasDiscordWebhook: false, closesAt: (before.meta as Map<string, any>).get("state").closesAt });
    expect(server.migration).toMatchObject({ source: "legacy", status: "complete" });
    for (const u of [alice, bob, cara]) expect((await getDoc(`users/${u.uid}`)).serverIds).toEqual([id]);

    // Nothing legacy was touched (including the global collections, which stay put).
    expect(await legacySnapshot()).toEqual(before);
    expect(await getDoc("private/discord", id)).toBeNull();

    // A backup of every top-level collection, with counts.
    const files = readdirSync(backupDir);
    for (const c of [...COPIED, "registrations", "admins", "devlog", "auditLog", "system"]) expect(files.some((f) => f.endsWith(`-${c}.json`)), c).toBe(true);
    const players = JSON.parse(readFileSync(join(backupDir, files.find((f) => f.endsWith("-players.json"))!), "utf8"));
    expect(players).toHaveLength(3);
    expect(res.counts.players).toBe(3);
  });

  it("is idempotent: a second run creates nothing new and still passes", async () => {
    await seedLegacy();
    const first = await run({ execute: true });
    const serversAfterFirst = (await db.collection("servers").get()).size;
    const copied = async () => Object.fromEntries(await Promise.all((COPIED as string[]).map(async (c) => [c, await snapshot(`servers/${first.serverId}/${c}`)])));
    const snapA = await copied();
    const second = await run({ execute: true, backupDir: join(backupDir, "again") });
    expect(second.ok, second.problems.join("; ")).toBe(true);
    expect(second.serverId).toBe(first.serverId);
    expect((await db.collection("servers").get()).size).toBe(serversAfterFirst);
    expect(await copied()).toEqual(snapA);
    expect((await db.collection("users").get()).size).toBe(3);
    for (const u of [alice, bob, cara]) expect((await getDoc(`users/${u.uid}`)).serverIds).toEqual([first.serverId]);
  });

  it("resumes after a partial failure without duplicating or corrupting anything", async () => {
    await seedLegacy();
    const first = await run({ execute: true });
    const id = first.serverId as string;
    // Simulate a run that died half way: some copied documents and a users doc are missing, the marker is only "in progress".
    await db.doc(`servers/${id}/trades/trade-1`).delete();
    await db.doc(`servers/${id}/holdings/${bob.uid}_${alice.uid}`).delete();
    await db.doc(`servers/${id}/stocks/${cara.uid}`).delete();
    await db.doc(`users/${cara.uid}`).delete();
    await db.doc(`servers/${id}`).update({ "migration.status": "in_progress" });
    const resumed = await run({ execute: true });
    expect(resumed.ok, resumed.problems.join("; ")).toBe(true);
    expect(resumed.serverId).toBe(id);
    expect(await getDoc("trades/trade-1", id)).toMatchObject({ linkedPostId: "post-1" });
    expect(await getDoc(`stocks/${cara.uid}`, id)).toMatchObject({ displayName: "Cara" });
    expect((await getDoc(`users/${cara.uid}`)).serverIds).toEqual([id]);
    expect((await db.collection(`servers/${id}/trades`).get()).size).toBe(1);
    expect((await getDoc(`servers/${id}`)).migration.status).toBe("complete");
  });

  it("never overwrites newer data in the new place: a conflict stops the run with nothing changed", async () => {
    await seedLegacy();
    const first = await run({ execute: true });
    const id = first.serverId as string;
    // Activity after cutover changed a copied document.
    await db.doc(`servers/${id}/players/${bob.uid}`).update({ cash: 1.23 });
    const lines: string[] = [];
    await expect(run({ execute: true, log: (l: string) => lines.push(l) })).rejects.toThrow(/Refusing to write/);
    expect(lines.join("\n")).toContain("CONFLICT");
    expect((await getDoc(`players/${bob.uid}`, id)).cash).toBe(1.23); // untouched
    // And the dry run says the same.
    const dry = await migrate({ db, project: PROJECT, name: "DYF", log: quiet });
    expect(dry.ok).toBe(false);
  });
});

describe("the migrated data works with the new functions", () => {
  it("players can trade in the new server, and the old layout is not read", async () => {
    await seedLegacy();
    const res = await run({ execute: true });
    const id = res.serverId as string;
    await db.doc("system/maintenance").set({ enabled: false });
    const tradedAt = Date.now();
    const t = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 100, serverId: id });
    expect(t).toMatchObject({ traderId: bob.uid, stockId: alice.uid, week: 4 });
    // Bob had 987.65 in the migrated data.
    expect((await getDoc(`players/${bob.uid}`, id)).cash).toBeCloseTo(887.65, 6);
    expect((await getDoc(`holdings/${bob.uid}_${alice.uid}`, id)).shares).toBeGreaterThan(4.5);
    expect((await getDoc("meta/state", id)).prizePool).toBeGreaterThan(37.25);
    // The legacy copy is exactly as it was: new activity never reaches it.
    expect((await db.doc(`players/${bob.uid}`).get()).data()!.cash).toBe(987.65);
    expect((await db.doc("meta/state").get()).data()!.prizePool).toBe(37.25);
    // And the rules deny the old top-level collections to clients, admin included.
    await db.doc(`admins/${bob.uid}`).set({});
    const { clientRead } = await import("./helpers");
    expect(await clientRead(bob, `players/${bob.uid}`, null)).toBe(403);
    expect(await clientRead(bob, `players/${bob.uid}`, id)).toBe(200);
    // The trade fires triggers (net-worth points, margin checks). The server code is the same in every test
    // (it's derived from the project and name), so let them finish before the next test wipes and re-seeds.
    await settleTriggers(id, tradedAt, [bob.uid, cara.uid]);
  });
});

describe("delete-legacy", () => {
  it("needs the exact phrase and a completed migration, then removes only the legacy game collections", async () => {
    await seedLegacy();
    await expect(deleteLegacy({ db, project: PROJECT, typed: "yes", log: quiet })).rejects.toThrow(/phrase/);
    await expect(deleteLegacy({ db, project: PROJECT, typed: confirmationPhrase(PROJECT), log: quiet })).rejects.toThrow(/No completed migration/);
    expect((await db.collection("players").get()).size).toBe(3);

    const res = await run({ execute: true });
    expect(res.ok, res.problems.join("; ")).toBe(true);
    const id = res.serverId as string;
    expect(await deleteLegacy({ db, project: PROJECT, typed: confirmationPhrase(PROJECT), log: quiet })).toMatchObject({ serverId: id });
    for (const c of COPIED as string[]) expect((await db.collection(c).get()).size, c).toBe(0);
    // Kept: the new server and the global collections.
    expect((await db.collection(`servers/${id}/players`).get()).size).toBe(3);
    expect((await db.collection("users").get()).size).toBe(3);
    for (const c of ["registrations", "admins", "devlog", "auditLog"]) expect((await db.collection(c).get()).size, c).toBeGreaterThan(0);
  });

  it("refuses if the new copy is smaller than what it would delete", async () => {
    await seedLegacy();
    const res = await run({ execute: true });
    await db.doc(`servers/${res.serverId}/trades/trade-1`).delete();
    await expect(deleteLegacy({ db, project: PROJECT, typed: confirmationPhrase(PROJECT), log: quiet })).rejects.toThrow(/Nothing was deleted/);
    expect((await db.collection("trades").get()).size).toBe(1);
  });
});
