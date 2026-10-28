import { beforeEach, describe, expect, it } from "vitest";
import { call, getDoc, listDocs, patchDoc, setupPlayers, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
let cara: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara] = await setupPlayers("Alice", "Bob", "Cara");
});

const DAY = 86_400_000;

describe("while you were away", () => {
  it("snapshots each session and recaps after two days away", async () => {
    const first = await call(bob, "touch");
    expect(first).toMatchObject({ player: true, previous: null, recap: null });
    expect((await getDoc(`players/${bob.uid}`)).seenSnapshot).toMatchObject({ netWorth: 1000, week: 1 });

    // Bob disappears for three days; Alice buys him and Cara shorts him.
    await patchDoc(`players/${bob.uid}`, { lastActiveAt: Date.now() - 3 * DAY });
    await call(alice, "trade", { stockId: bob.uid, side: "buy", amount: 150 });
    await call(cara, "openShort", { stockId: bob.uid, shares: 1 });

    const back = await call(bob, "touch");
    expect(back.previous).toMatchObject({ netWorth: 1000, week: 1 });
    expect(back.recap).toMatchObject({ netWorthThen: 1000, weeksClosed: 0, prizes: [], priceThen: 50 });
    expect(back.recap.traders.map((t: any) => t.traderName)).toEqual(["Alice", "Cara"]);
    expect(back.recap.traders[0].bought).toBeCloseTo(150, 6);
    expect(back.recap.traders[1].shorted).toBeGreaterThan(0);
    expect(back.recap.rankNow).toBeGreaterThanOrEqual(1);

    // Straight back again: no recap.
    expect((await call(bob, "touch")).recap).toBeNull();
  });

  it("respects recapAfterHours", async () => {
    await call(alice, "updateConfig", { patch: { recapAfterHours: 100 } });
    await patchDoc(`players/${bob.uid}`, { lastActiveAt: Date.now() - 3 * DAY });
    expect((await call(bob, "touch")).recap).toBeNull();
  });
});

describe("price history and records", () => {
  it("stores recent prices on the stock and each trade, and tracks all-time highs", async () => {
    const t = await call(alice, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    expect(t.recentPrices).toEqual([50, t.priceAfter]);
    const stock = await getDoc(`stocks/${bob.uid}`);
    expect(stock).toMatchObject({ recentPrices: [50, t.priceAfter], allTimeHigh: t.priceAfter, allTimeLow: 50 });
    // Week 1: too fresh to announce records.
    expect((await listDocs("discordOutbox")).some((d) => d.kind === "allTimeHigh")).toBe(false);

    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    await call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    const records = (await listDocs("discordOutbox")).filter((d) => d.kind === "allTimeHigh");
    expect(records).toHaveLength(1);
    expect(records[0].message.title).toContain("All-time high · $BOB");
    // At most one per week.
    await call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    expect((await listDocs("discordOutbox")).filter((d) => d.kind === "allTimeHigh")).toHaveLength(1);
  });
});

describe("weekly awards", () => {
  it("are computed at the close and stored on the report", async () => {
    await call(alice, "trade", { stockId: bob.uid, side: "buy", amount: 300 });
    expect(await getDoc(`holdings/${alice.uid}_${bob.uid}`)).toMatchObject({ costBasis: 300 });
    // Alice's position goes underwater when Cara shorts Bob hard.
    await call(cara, "openShort", { stockId: bob.uid, shares: 8 });
    const post = await call(bob, "createPost", { text: "I'm going to the moon" });
    await call(alice, "toggleReaction", { postId: post.id, reaction: "down" });
    await call(cara, "toggleReaction", { postId: post.id, reaction: "down" });

    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const report = await getDoc("weeklyReports/week-0001");
    const byKey = Object.fromEntries(report.highlights.awards.map((a: any) => [a.key, a]));
    expect(byKey.biggestMover.playerId).toBe(bob.uid);
    expect(byKey.bagHolder).toMatchObject({ playerId: alice.uid, stockId: bob.uid });
    expect(byKey.worstTake).toMatchObject({ playerId: bob.uid, postId: post.id, value: 2 });
    expect(byKey.mostReacted).toMatchObject({ playerId: bob.uid, value: 2 });
    // Alice only bought this week, so nobody has Diamond Hands yet.
    expect(byKey.diamondHands).toBeUndefined();
    expect(report.markdown).toContain("💼 Bag Holder: **Alice**");
  });

  it("backfills cost basis for holdings from before it was tracked", async () => {
    await call(alice, "trade", { stockId: bob.uid, side: "buy", amount: 200 });
    await patchDoc(`holdings/${alice.uid}_${bob.uid}`, { costBasis: null, holdingSince: null });
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const h = await getDoc(`holdings/${alice.uid}_${bob.uid}`);
    expect(h.costBasis).toBeCloseTo(200, 6);
    expect(h.holdingSince).toBeGreaterThan(0);
  });

  it("rebuilds cost basis on the next trade too", async () => {
    await call(alice, "trade", { stockId: bob.uid, side: "buy", amount: 200 });
    await patchDoc(`holdings/${alice.uid}_${bob.uid}`, { costBasis: null, holdingSince: null });
    const held = (await getDoc(`holdings/${alice.uid}_${bob.uid}`)).shares;
    await call(alice, "trade", { stockId: bob.uid, side: "sell", amount: held / 2 });
    expect((await getDoc(`holdings/${alice.uid}_${bob.uid}`)).costBasis).toBeCloseTo(100, 6);
  });
});
