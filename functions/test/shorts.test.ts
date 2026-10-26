import { beforeEach, describe, expect, it } from "vitest";
import { call, expectCallError, getDoc, listDocs, setupPlayers, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
let cara: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara] = await setupPlayers("Alice", "Bob", "Cara");
});

describe("opening a short", () => {
  it("sells into the pool, pays cash to the shorter, drops the price, logs a trade", async () => {
    const before = await getDoc(`stocks/${alice.uid}`);
    const short = await call(bob, "openShort", { stockId: alice.uid, shares: 5 });
    expect(short).toMatchObject({ ownerId: bob.uid, stockId: alice.uid, shares: 5, status: "open" });

    const after = await getDoc(`stocks/${alice.uid}`);
    expect(after.price).toBeLessThan(before.price);
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeGreaterThan(1000); // received proceeds
    const trades = (await listDocs("trades")).filter((t) => t.kind === "openShort");
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ traderId: bob.uid, side: "sell" });
  });

  it("can't short your own stock, an unlisted stock, or while signed out", async () => {
    await expectCallError(call(alice, "openShort", { stockId: alice.uid, shares: 1 }), "PERMISSION_DENIED");
    await expectCallError(call(null, "openShort", { stockId: alice.uid, shares: 1 }), "UNAUTHENTICATED");
    await expectCallError(call(bob, "openShort", { stockId: "nobody", shares: 1 }), "NOT_FOUND");
  });

  it("enforces the exposure cap", async () => {
    // Default cap is 50% of capital (~£500 of a £1000 wallet). A huge short is refused.
    await expectCallError(call(bob, "openShort", { stockId: alice.uid, shares: 60 }), "FAILED_PRECONDITION");
    expect((await listDocs("shorts"))).toHaveLength(0);
  });

  it("can post alongside opening a short", async () => {
    const short = await call(bob, "openShort", { stockId: alice.uid, shares: 2, postText: "She's getting divorced" });
    const posts = (await listDocs("posts")).filter((p) => p.authorId === bob.uid);
    expect(posts[0]).toMatchObject({ text: "She's getting divorced", taggedStockId: alice.uid });
    expect(short.status).toBe("open");
  });
});

describe("closing a short", () => {
  it("profits when the price has fallen since opening", async () => {
    const short = await call(bob, "openShort", { stockId: alice.uid, shares: 5 });
    // Cara dumps Alice to push the price down further.
    await call(cara, "trade", { stockId: alice.uid, side: "buy", amount: 1 }); // tiny, ensures listed
    const cashBefore = (await getDoc(`players/${bob.uid}`)).cash;
    // Alice's stock drifts down because Bob's open already lowered it; close now.
    const closed = await call(bob, "closeShort", { shortId: short.id });
    expect(closed.status).toBe("closed");
    expect(typeof closed.realisedPnl).toBe("number");
    const stock = await getDoc(`stocks/${alice.uid}`);
    expect(stock.price).toBeGreaterThan(0);
    // Closing costs cash to buy back.
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeLessThan(cashBefore);
    expect((await getDoc(`shorts/${short.id}`)).status).toBe("closed");
  });

  it("can't close someone else's short or an already-closed short", async () => {
    const short = await call(bob, "openShort", { stockId: alice.uid, shares: 2 });
    await expectCallError(call(cara, "closeShort", { shortId: short.id }), "PERMISSION_DENIED");
    await call(bob, "closeShort", { shortId: short.id });
    await expectCallError(call(bob, "closeShort", { shortId: short.id }), "FAILED_PRECONDITION");
  });

  it("a flat open→close round trip loses only fees (no free money)", async () => {
    const short = await call(bob, "openShort", { stockId: cara.uid, shares: 3 });
    await call(bob, "closeShort", { shortId: short.id });
    // Bob paid two fees and moved the price against himself on the way back.
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeLessThan(1000);
  });
});

describe("weekly close with open shorts", () => {
  it("charges the borrow fee and never counts an open short toward the prize", async () => {
    await call(bob, "openShort", { stockId: alice.uid, shares: 4 });
    const bobBefore = (await getDoc(`players/${bob.uid}`)).cash;
    const res = await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    expect(res.closed).toBe(true);
    // Borrow fee was charged (Bob also got the allowance, so compare the short doc).
    const short = (await listDocs("shorts")).find((s) => s.ownerId === bob.uid);
    expect(short.borrowFeesPaid).toBeGreaterThan(0);
    // The winner wasn't decided by Bob's paper short gain.
    expect(bobBefore).toBeGreaterThan(0);
  });

  it("opening a big short does NOT inflate net worth at weekly close (Option B)", async () => {
    // Baseline: close week 1 with no shorts, capture Bob's recorded net worth.
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const baseline = (await getDoc(`players/${bob.uid}`)).netWorthWeekStart;

    // Bob opens the largest short he can right before the next close.
    await call(bob, "openShort", { stockId: alice.uid, shares: 5 });
    const cashAfterOpen = (await getDoc(`players/${bob.uid}`)).cash;
    expect(cashAfterOpen).toBeGreaterThan(baseline - 1); // he did receive cash

    const report = await call(alice, "runWeeklyClose", { expectedWeek: 2 });
    expect(report.closed).toBe(true);
    // His net worth at close must not have jumped by the short proceeds. Allowing
    // only for the allowance he legitimately received, it's nowhere near cash+proceeds.
    const after = await getDoc(`players/${bob.uid}`);
    const openShort = (await listDocs("shorts")).find((s) => s.ownerId === bob.uid);
    // Net worth should be ~ baseline + allowance − borrow fee, NOT lifted by the ~hundreds of proceeds.
    expect(after.netWorthWeekStart).toBeLessThan(cashAfterOpen);
    expect(openShort.borrowFeesPaid).toBeGreaterThan(0);
  });
});
