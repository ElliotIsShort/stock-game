import { beforeEach, describe, expect, it } from "vitest";
import { call, clientRead, clientWrite, expectCallError, getDoc, listDocs, setClosesAt, setupPlayers, sleep, tickScheduler, wipeEmulators, type User } from "./helpers";

let alice: User; // admin
let bob: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob] = await setupPlayers("Alice", "Bob");
});

describe("maintenance mode", () => {
  it("only an admin can switch it", async () => {
    await expectCallError(call(bob, "setMaintenance", { enabled: true }), "PERMISSION_DENIED");
    await expectCallError(call(alice, "setMaintenance", { enabled: "yes" }), "INVALID_ARGUMENT");
    expect(await getDoc("system/maintenance")).toBeNull();
  });

  it("blocks player and admin mutations with a clear message, and lifts again", async () => {
    await call(alice, "setMaintenance", { enabled: true });
    expect((await getDoc("system/maintenance")).enabled).toBe(true);

    const err = await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 10 }), "UNAVAILABLE");
    expect(err.message).toContain("being upgraded");
    await expectCallError(call(bob, "createPost", { text: "hello" }), "UNAVAILABLE");
    await expectCallError(call(bob, "touch", {}), "UNAVAILABLE");
    await expectCallError(call(alice, "updateConfig", { patch: { weeklyAllowance: 300 } }), "UNAVAILABLE");
    await expectCallError(call(alice, "runWeeklyClose", { expectedWeek: 1 }), "UNAVAILABLE");
    expect((await getDoc(`players/${bob.uid}`)).cash).toBe(1000);

    // The switch itself still works so the admin can turn it back off.
    await call(alice, "setMaintenance", { enabled: false });
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 10 });
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeCloseTo(990, 9);
  });

  it("unauthenticated calls still get the sign-in error", async () => {
    await call(alice, "setMaintenance", { enabled: true });
    await expectCallError(call(null, "trade", { stockId: alice.uid, side: "buy", amount: 10 }), "UNAUTHENTICATED");
  });

  it("the scheduler does not close a due week while on", async () => {
    await call(alice, "setMaintenance", { enabled: true });
    const state = await getDoc("meta/state");
    // Make the week due by moving closesAt into the past (bypasses rules, like the console).
    await setClosesAt(Date.now() - 60_000);
    await tickScheduler();
    await sleep(500);
    expect((await getDoc("meta/state")).currentWeek).toBe(state.currentWeek);
    expect((await listDocs("weeklyReports")).length).toBe(0);
  });

  it("is readable by signed-in users (for the banner) and never writable", async () => {
    await call(alice, "setMaintenance", { enabled: true });
    expect(await clientRead(bob, "system/maintenance")).toBe(200);
    expect(await clientWrite(bob, "system/maintenance", { enabled: false as never })).toBe(403);
  });
});
