import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, quoteBuy, quoteSell } from "@fsm/shared";
import { call, expectCallError, getDoc, setupPlayers, wipeEmulators, type User } from "./helpers";

let alice: User;
let bob: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob] = await setupPlayers("Alice", "Bob");
});

const fee = DEFAULT_CONFIG.tradingFeePct;

describe("buying (§2)", () => {
  it("executes the AMM math server-side and moves cash, shares, pool and prize pool", async () => {
    const before = await getDoc(`stocks/${alice.uid}`);
    const expected = quoteBuy(before, 100, fee);
    const t = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 100 });

    expect(t.shares).toBeCloseTo(expected.shares, 9);
    expect(t.fee).toBeCloseTo(100 * fee, 9);
    expect(t.priceAfter).toBeCloseTo(expected.priceAfter, 9);

    const after = await getDoc(`stocks/${alice.uid}`);
    expect(after.price).toBeCloseTo(expected.priceAfter, 9);
    expect(after.poolCash).toBeCloseTo(before.poolCash + 100 * (1 - fee), 6);
    expect(after.weekTradeCount).toBe(1);
    expect(after.weekHigh).toBeCloseTo(expected.priceAfter, 9);

    expect((await getDoc(`players/${bob.uid}`)).cash).toBeCloseTo(900, 9);
    expect((await getDoc(`holdings/${bob.uid}_${alice.uid}`)).shares).toBeCloseTo(expected.shares, 9);
    expect((await getDoc("meta/state")).prizePool).toBeCloseTo(100 * fee, 9);
  });

  it("can't buy your own stock", async () => {
    await expectCallError(call(alice, "trade", { stockId: alice.uid, side: "buy", amount: 10 }), "PERMISSION_DENIED");
  });

  it("can't spend more cash than you have", async () => {
    await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 1000.01 }), "FAILED_PRECONDITION");
    expect((await getDoc(`players/${bob.uid}`)).cash).toBe(1000);
  });

  it("validates input", async () => {
    await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: -5 }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "hold", amount: 5 }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: "5" }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "trade", { stockId: "nobody", side: "buy", amount: 5 }), "NOT_FOUND");
    await expectCallError(call(null, "trade", { stockId: alice.uid, side: "buy", amount: 5 }), "UNAUTHENTICATED");
  });

  it("can spend exactly all of your cash", async () => {
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 1000 });
    expect((await getDoc(`players/${bob.uid}`)).cash).toBe(0);
  });
});

describe("selling (§2)", () => {
  it("pays out the AMM amount minus fee", async () => {
    const buy = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 200 });
    const pool = await getDoc(`stocks/${alice.uid}`);
    const expected = quoteSell(pool, buy.shares / 2, fee);
    const cashBefore = (await getDoc(`players/${bob.uid}`)).cash;

    const sell = await call(bob, "trade", { stockId: alice.uid, side: "sell", amount: buy.shares / 2 });
    expect(sell.netCash).toBeCloseTo(expected.netCash, 9);
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeCloseTo(cashBefore + expected.netCash, 9);
    expect((await getDoc(`stocks/${alice.uid}`)).price).toBeLessThan(pool.price);
  });

  it("can't sell more than you hold", async () => {
    const buy = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 50 });
    await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "sell", amount: buy.shares * 2 }), "FAILED_PRECONDITION");
    await expectCallError(call(alice, "trade", { stockId: bob.uid, side: "sell", amount: 1 }), "FAILED_PRECONDITION");
  });

  it("selling everything removes the holding", async () => {
    const buy = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 50 });
    await call(bob, "trade", { stockId: alice.uid, side: "sell", amount: buy.shares });
    expect(await getDoc(`holdings/${bob.uid}_${alice.uid}`)).toBeNull();
  });
});

describe("trades in the feed (§7)", () => {
  it("records the trade and an optional linked post", async () => {
    const t = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 100, postText: "she's buying drinks tonight" });
    const trade = await getDoc(`trades/${t.id}`);
    expect(trade).toMatchObject({ traderId: bob.uid, stockId: alice.uid, side: "buy", week: 1, traderName: "Bob", stockName: "Alice" });
    expect(trade.linkedPostId).toBeTruthy();
    const post = await getDoc(`posts/${trade.linkedPostId}`);
    expect(post).toMatchObject({ authorId: bob.uid, taggedStockId: alice.uid, linkedTradeId: t.id, text: "she's buying drinks tonight" });
    expect(post.linkedTradeSummary).toContain("Bob bought");
  });

  it("rejects overly long trade posts without trading", async () => {
    const long = "x".repeat(DEFAULT_CONFIG.maxPostLength + 1);
    await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 10, postText: long }), "INVALID_ARGUMENT");
    expect((await getDoc(`players/${bob.uid}`)).cash).toBe(1000);
  });
});
