import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@fsm/shared";
import { call, expectCallError, getDoc, listDocs, setupPlayers, signUp, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
let cara: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara] = await setupPlayers("Alice", "Bob", "Cara");
});

describe("config", () => {
  it("admins can change settings; bad values and non-admins are rejected", async () => {
    const after = await call(alice, "updateConfig", { patch: { tradingFeePct: 0.02 } });
    expect(after.tradingFeePct).toBe(0.02);
    expect((await getDoc("config/global")).tradingFeePct).toBe(0.02);

    await expectCallError(call(alice, "updateConfig", { patch: { tradingFeePct: 5 } }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "updateConfig", { patch: { nope: 1 } }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "updateConfig", { patch: { tradingFeePct: 0 } }), "PERMISSION_DENIED");

    const audit = (await listDocs("auditLog")).find((e) => e.action === "updateConfig");
    expect(audit.details.changed.tradingFeePct).toEqual({ from: DEFAULT_CONFIG.tradingFeePct, to: 0.02 });
  });

  it("new fee applies to the next trade", async () => {
    await call(alice, "updateConfig", { patch: { tradingFeePct: 0.1 } });
    const t = await call(bob, "trade", { stockId: cara.uid, side: "buy", amount: 100 });
    expect(t.fee).toBeCloseTo(10, 9);
  });
});

describe("delist (§5)", () => {
  it("pays holders at the last price, removes the stock and deactivates the account", async () => {
    await call(bob, "trade", { stockId: cara.uid, side: "buy", amount: 100 });
    const holding = await getDoc(`holdings/${bob.uid}_${cara.uid}`);
    const stock = await getDoc(`stocks/${cara.uid}`);
    const bobCash = (await getDoc(`players/${bob.uid}`)).cash;

    await expectCallError(call(bob, "delistPlayer", { uid: cara.uid }), "PERMISSION_DENIED");
    const res = await call(alice, "delistPlayer", { uid: cara.uid });
    expect(res.payouts).toHaveLength(1);

    expect((await getDoc(`players/${bob.uid}`)).cash).toBeCloseTo(bobCash + holding.shares * stock.price, 6);
    expect(await getDoc(`holdings/${bob.uid}_${cara.uid}`)).toBeNull();
    expect((await getDoc(`stocks/${cara.uid}`)).listed).toBe(false);
    expect((await getDoc(`players/${cara.uid}`)).isActive).toBe(false);

    await expectCallError(call(bob, "trade", { stockId: cara.uid, side: "buy", amount: 10 }), "FAILED_PRECONDITION");
    await expectCallError(call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 10 }), "PERMISSION_DENIED");
    await expectCallError(call(alice, "delistPlayer", { uid: cara.uid }), "FAILED_PRECONDITION");
  });
});

describe("full reset", () => {
  it("is admin-only and needs the confirmation word", async () => {
    await expectCallError(call(bob, "resetGame", { confirm: "RESET" }), "PERMISSION_DENIED");
    await expectCallError(call(alice, "resetGame", {}), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "resetGame", { confirm: "reset" }), "INVALID_ARGUMENT");
    expect(await getDoc(`players/${bob.uid}`)).not.toBeNull();
  });

  it("wipes game data back to day one, keeps settings/admins/audit, and re-queues players", async () => {
    // Build up some history.
    await call(bob, "trade", { stockId: cara.uid, side: "buy", amount: 200, postText: "to the moon" });
    await call(alice, "updateConfig", { patch: { postCooldownSeconds: 0 } });
    await call(bob, "createPost", { text: "hello" });
    await call(bob, "setStockPhoto", { photo: "data:image/jpeg;base64,/9j/4AAQ" });
    await call(alice, "updateConfig", { patch: { weeklyAllowance: 250 } });
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    await call(alice, "delistPlayer", { uid: cara.uid });
    const pending = await signUp("Dan");
    await call(pending, "register", { displayName: "Dan" });

    const res = await call(alice, "resetGame", { confirm: "RESET" });
    expect(res.requeued).toBe(2); // Alice + Bob
    expect(res.declined).toBe(1); // Cara was delisted
    expect(res.deleted.players).toBe(3);

    for (const c of ["players", "stocks", "holdings", "trades", "posts", "photos", "netWorthHistory", "weeklyReports"]) {
      expect(await listDocs(c), c).toEqual([]);
    }
    expect(await getDoc("meta/state")).toMatchObject({ currentWeek: 1, prizePool: 0, weekFees: 0, lastCloseAt: null });

    // Kept: config, admins, audit log (plus a reset entry).
    expect((await getDoc("config/global")).weeklyAllowance).toBe(250);
    expect(await getDoc(`admins/${alice.uid}`)).not.toBeNull();
    const actions = (await listDocs("auditLog")).map((e) => e.action);
    expect(actions).toContain("updateConfig");
    expect(actions).toContain("resetGame");

    expect((await getDoc(`registrations/${alice.uid}`)).status).toBe("pending");
    expect((await getDoc(`registrations/${bob.uid}`)).status).toBe("pending");
    expect((await getDoc(`registrations/${cara.uid}`)).status).toBe("rejected");
    expect((await getDoc(`registrations/${pending.uid}`)).status).toBe("pending");

    // Players can't act until re-approved…
    await expectCallError(call(bob, "createPost", { text: "still here?" }), "PERMISSION_DENIED");

    // …and re-approval starts them fresh as week-1 founders at the base price.
    const again = await call(alice, "approvePlayer", { uid: bob.uid });
    expect(again).toMatchObject({ startingCash: DEFAULT_CONFIG.baseStartingCash, listingPrice: DEFAULT_CONFIG.baseStockPrice });
    expect(await getDoc(`players/${bob.uid}`)).toMatchObject({ cash: 1000, joinWeek: 1, totalAllowances: 0 });
  });
});
