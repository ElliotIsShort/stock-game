import { beforeEach, describe, expect, it } from "vitest";
import { CLOSE_WEEK_MS, formatCloseTime, legacyClosesAt } from "@fsm/shared";
import { call, clearFields, expectCallError, getDoc, listDocs, makeServer, patchDoc, registerUser, setClosesAt, setupPlayers, tickScheduler, wipeEmulators, SERVER, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob] = await setupPlayers("Alice", "Bob");
});

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("setCloseTime", () => {
  it("is admin only and validates the time", async () => {
    const soon = Date.now() + 2 * HOUR;
    await expectCallError(call(bob, "setCloseTime", { closesAt: soon }), "PERMISSION_DENIED");
    await expectCallError(call(null, "setCloseTime", { closesAt: soon }), "UNAUTHENTICATED");
    await expectCallError(call(alice, "setCloseTime", { closesAt: Date.now() - HOUR }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "setCloseTime", { closesAt: Date.now() + 2 * MIN }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "setCloseTime", { closesAt: "Sunday" }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "setCloseTime", {}), "INVALID_ARGUMENT");
  });

  it("updates the state, audits before/after and posts to the feed and Discord", async () => {
    const before = (await getDoc("meta/state")).closesAt;
    expect(typeof before).toBe("number");
    const at = Date.now() + 3 * 24 * HOUR;
    const res = await call(alice, "setCloseTime", { closesAt: at });
    expect(res).toMatchObject({ week: 1, closesAt: at, previous: before });
    expect((await getDoc("meta/state")).closesAt).toBe(at);

    const audit = (await listDocs("auditLog")).find((e) => e.action === "setCloseTime");
    expect(audit).toMatchObject({ actorId: alice.uid, details: { week: 1, closesAt: { from: before, to: at } } });

    const post = (await listDocs("posts")).find((p) => p.system && p.text.startsWith("Week 1 now closes"));
    expect(post.text).toBe(`Week 1 now closes ${formatCloseTime(at)} UK time (was ${formatCloseTime(before)}).`);
    expect((await listDocs("discordOutbox")).some((d) => d.kind === "closeTime")).toBe(true);
  });
});

describe("closeScheduler", () => {
  it("does nothing before closesAt", async () => {
    await setClosesAt(Date.now() + HOUR);
    await tickScheduler();
    expect((await getDoc("meta/state")).currentWeek).toBe(1);
    expect(await listDocs("weeklyReports")).toEqual([]);
  });

  it("closes exactly when due and moves closesAt on by whole weeks from the old time", async () => {
    const due = Date.now() - 30_000;
    await setClosesAt(due);
    await tickScheduler();
    const state = await getDoc("meta/state");
    expect(state.currentWeek).toBe(2);
    expect(state.closesAt).toBe(due + CLOSE_WEEK_MS);
    const report = await getDoc("weeklyReports/week-0001");
    expect(report.trigger).toBe("schedule");
    const post = (await listDocs("posts")).find((p) => p.system && p.text.startsWith("Week 1 closed"));
    expect(post.text).toContain(`Week 2 closes ${formatCloseTime(due + CLOSE_WEEK_MS)}`);
    expect((await listDocs("auditLog")).find((e) => e.action === "weeklyClose")).toMatchObject({ actorId: "scheduler" });

    // The next tick isn't due.
    await tickScheduler();
    expect((await getDoc("meta/state")).currentWeek).toBe(2);
  });

  it("skips missed weeks after an outage", async () => {
    const due = Date.now() - 2 * CLOSE_WEEK_MS - HOUR;
    await setClosesAt(due);
    await tickScheduler();
    const state = await getDoc("meta/state");
    expect(state.currentWeek).toBe(2);
    expect(state.closesAt).toBe(due + 3 * CLOSE_WEEK_MS);
    expect(state.closesAt).toBeGreaterThan(Date.now());
  });

  it("never double-closes when ticks overlap", async () => {
    await setClosesAt(Date.now() - 1000);
    await Promise.all([tickScheduler(), tickScheduler(), tickScheduler()]);
    expect((await getDoc("meta/state")).currentWeek).toBe(2);
    expect((await listDocs("weeklyReports")).map((r) => r.week)).toEqual([1]);
  });

  it("leaves closesAt alone on an early manual close, and advances it on a late one", async () => {
    const later = Date.now() + 2 * 24 * HOUR;
    await setClosesAt(later);
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    expect(await getDoc("meta/state")).toMatchObject({ currentWeek: 2, closesAt: later });

    // The scheduler was down past the close time and the admin closed by hand.
    const missed = Date.now() - 10 * MIN;
    await setClosesAt(missed);
    await call(alice, "runWeeklyClose", { expectedWeek: 2 });
    expect(await getDoc("meta/state")).toMatchObject({ currentWeek: 3, closesAt: missed + CLOSE_WEEK_MS });
  });
});

describe("legacy state without closesAt", () => {
  it("is derived from the old Sunday 20:00 UTC schedule and persisted by the scheduler", async () => {
    await clearFields("meta/state", ["closesAt"]);
    // The server doc says it's due (stale), the state has no close time at all.
    await patchDoc(`servers/${SERVER}`, { closesAt: Date.now() - 1000 });
    expect((await getDoc("meta/state")).closesAt).toBeUndefined();
    await tickScheduler();
    const state = await getDoc("meta/state");
    expect(state.closesAt).toBe(legacyClosesAt(Date.now(), state.lastCloseAt ?? null));
    expect((await getDoc(`servers/${SERVER}`)).closesAt).toBe(state.closesAt);
    expect(new Date(state.closesAt).getUTCDay()).toBe(0);
    expect(new Date(state.closesAt).getUTCHours()).toBe(20);
    expect(state.currentWeek).toBe(1);
  });

  it("is persisted by the client's touch too", async () => {
    await clearFields("meta/state", ["closesAt"]);
    await call(bob, "touch");
    expect((await getDoc("meta/state")).closesAt).toBe(legacyClosesAt(Date.now(), null));
  });

  it("ignores the retired minHoursBetweenAutoCloses setting", async () => {
    await patchDoc("config/global", { minHoursBetweenAutoCloses: 144 });
    await setClosesAt(Date.now() - 1000, SERVER, { lastCloseAt: Date.now() - HOUR });
    await tickScheduler();
    expect((await getDoc("meta/state")).currentWeek).toBe(2);
    await expectCallError(call(alice, "updateConfig", { patch: { minHoursBetweenAutoCloses: 1 } }), "INVALID_ARGUMENT");
    // Saving any other setting drops the retired key from the stored doc.
    await call(alice, "updateConfig", { patch: { weeklyAllowance: 250 } });
    expect((await getDoc("config/global")).minHoursBetweenAutoCloses).toBeUndefined();
  });
});

describe("several servers", () => {
  it("closes only the due server and leaves the others alone", async () => {
    const a = SERVER;
    const b = await makeServer(alice, "Server B", { switchTo: false });
    const c = await makeServer(alice, "Server C", { switchTo: false });
    await call(alice, "addPlayerToServer", { uid: alice.uid, serverId: b, displayName: "Alice B" });
    await setClosesAt(Date.now() - 30_000, b);
    await tickScheduler();
    expect((await getDoc("meta/state", b)).currentWeek).toBe(2);
    expect((await getDoc("meta/state", a)).currentWeek).toBe(1);
    expect((await getDoc("meta/state", c)).currentWeek).toBe(1);
    expect(await listDocs("weeklyReports", a)).toEqual([]);
    expect((await listDocs("weeklyReports", b)).map((r) => r.week)).toEqual([1]);
    // The denormalised copy moved on in the same transaction.
    expect((await getDoc(`servers/${b}`)).closesAt).toBe((await getDoc("meta/state", b)).closesAt);
    expect((await getDoc(`servers/${b}`)).closesAt).toBeGreaterThan(Date.now());
  });

  it("skips archived servers even when they are due", async () => {
    await setClosesAt(Date.now() - 30_000);
    await call(alice, "archiveServer", {});
    await tickScheduler();
    expect((await getDoc("meta/state")).currentWeek).toBe(1);
    await call(alice, "unarchiveServer", {});
    await tickScheduler();
    expect((await getDoc("meta/state")).currentWeek).toBe(2);
  });

  it("setCloseTime keeps the server doc's copy in step and only touches the named server", async () => {
    const b = await makeServer(alice, "Server B", { switchTo: false });
    const at = Date.now() + 5 * 24 * HOUR;
    await call(alice, "setCloseTime", { closesAt: at, serverId: b });
    expect((await getDoc(`servers/${b}`)).closesAt).toBe(at);
    expect((await getDoc("meta/state", b)).closesAt).toBe(at);
    expect((await getDoc("meta/state")).closesAt).not.toBe(at);
  });
});
