import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, startingCash, targetPoolCash } from "@fsm/shared";
import { call, clientRead, clientWrite, expectCallError, getDoc, makeAdmin, setupPlayers, signUp, wipeEmulators } from "./helpers";

beforeEach(wipeEmulators);

describe("registration and approval (§4.3)", () => {
  it("registers a pending user with no funds", async () => {
    const u = await signUp("Alice");
    await call(u, "register", { displayName: "  Alice   Smith " });
    const reg = await getDoc(`registrations/${u.uid}`);
    expect(reg).toMatchObject({ status: "pending", displayName: "Alice Smith" });
    expect(await getDoc(`players/${u.uid}`)).toBeNull();
  });

  it("rejects unauthenticated, duplicate and too-short names", async () => {
    await expectCallError(call(null, "register", { displayName: "Ghost" }), "UNAUTHENTICATED");
    const a = await signUp("a");
    const b = await signUp("b");
    await call(a, "register", { displayName: "Sam" });
    await expectCallError(call(b, "register", { displayName: "sam" }), "ALREADY_EXISTS");
    await expectCallError(call(b, "register", { displayName: "x" }), "INVALID_ARGUMENT");
    await expectCallError(call(a, "register", { displayName: "Sam" }), "ALREADY_EXISTS");
  });

  it("only admins can approve or reject", async () => {
    const a = await signUp("a");
    const b = await signUp("b");
    await call(b, "register", { displayName: "Bob" });
    await expectCallError(call(a, "approvePlayer", { uid: b.uid }), "PERMISSION_DENIED");
    await expectCallError(call(a, "rejectPlayer", { uid: b.uid }), "PERMISSION_DENIED");
  });

  it("approval atomically creates player, cash and a listed stock with a §2.1-sized pool", async () => {
    const admin = await signUp("admin");
    await makeAdmin(admin);
    const u = await signUp("Alice");
    await call(u, "register", { displayName: "Alice" });
    const res = await call(admin, "approvePlayer", { uid: u.uid });

    expect(res.startingCash).toBe(DEFAULT_CONFIG.baseStartingCash);
    expect(res.listingPrice).toBe(DEFAULT_CONFIG.baseStockPrice);

    const player = await getDoc(`players/${u.uid}`);
    expect(player).toMatchObject({ cash: 1000, joinWeek: 1, isActive: true, isIdle: false, startingCash: 1000, totalAllowances: 0 });

    const stock = await getDoc(`stocks/${u.uid}`);
    const expectedPool = targetPoolCash(1000, DEFAULT_CONFIG.targetTradeSize, DEFAULT_CONFIG.targetImpact);
    expect(stock.listed).toBe(true);
    expect(stock.price).toBe(50);
    expect(stock.poolCash).toBeCloseTo(expectedPool, 6);
    expect(stock.poolCash / stock.poolShares).toBeCloseTo(50, 9);
    expect(stock.k).toBeCloseTo(stock.poolCash * stock.poolShares, 3);

    expect(await getDoc(`registrations/${u.uid}`)).toMatchObject({ status: "approved", decidedBy: admin.uid });
    await expectCallError(call(admin, "approvePlayer", { uid: u.uid }), "FAILED_PRECONDITION");
  });

  it("later joiners get catch-up cash and list at the median price", async () => {
    const [alice, bob] = await setupPlayers("Alice", "Bob");
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 300 });
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });

    const cara = await signUp("Cara");
    await call(cara, "register", { displayName: "Cara" });
    const res = await call(alice, "approvePlayer", { uid: cara.uid });

    expect(res.startingCash).toBe(startingCash(2, DEFAULT_CONFIG));
    const [a, b] = [await getDoc(`stocks/${alice.uid}`), await getDoc(`stocks/${bob.uid}`)];
    expect(res.listingPrice).toBeCloseTo((a.price + b.price) / 2, 9);
  });

  it("a declined user can ask again", async () => {
    const admin = await signUp("admin");
    await makeAdmin(admin);
    const u = await signUp("Dan");
    await call(u, "register", { displayName: "Dan" });
    await call(admin, "rejectPlayer", { uid: u.uid });
    expect((await getDoc(`registrations/${u.uid}`)).status).toBe("rejected");
    await call(u, "register", { displayName: "Dan" });
    expect((await getDoc(`registrations/${u.uid}`)).status).toBe("pending");
  });
});

describe("security rules", () => {
  it("pending users can only read their own registration", async () => {
    const [alice] = await setupPlayers("Alice");
    const pending = await signUp("p");
    await call(pending, "register", { displayName: "Pending" });
    expect(await clientRead(pending, `registrations/${pending.uid}`)).toBe(200);
    expect(await clientRead(pending, `stocks/${alice.uid}`)).toBe(403);
    expect(await clientRead(pending, `players/${alice.uid}`)).toBe(403);
    expect(await clientRead(pending, `registrations/${alice.uid}`)).toBe(403);
  });

  it("players can read game data but never write it", async () => {
    const [alice, bob] = await setupPlayers("Alice", "Bob");
    expect(await clientRead(bob, `players/${alice.uid}`)).toBe(200);
    expect(await clientRead(bob, `stocks/${alice.uid}`)).toBe(200);
    expect(await clientRead(bob, "auditLog/x")).toBe(403);
    expect(await clientWrite(bob, `players/${bob.uid}`, { cash: 1e9 })).toBe(403);
    expect(await clientWrite(bob, `stocks/${alice.uid}`, { price: 0.01 })).toBe(403);
    expect(await clientWrite(bob, `holdings/${bob.uid}_${alice.uid}`, { shares: 1e6 })).toBe(403);
    expect(await clientWrite(bob, "meta/state", { prizePool: 1e9 })).toBe(403);
    expect(await clientWrite(bob, `admins/${bob.uid}`, {})).toBe(403);
    expect((await getDoc(`players/${bob.uid}`)).cash).toBe(1000);
  });
});
