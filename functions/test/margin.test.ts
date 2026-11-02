import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, MARGIN_CALL_MS, quoteCloseShort } from "@fsm/shared";
import { CallError, call, getDoc, listDocs, patchDoc, setupPlayers, sleep, tickScheduler, waitFor, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User; // the short-seller
let cara: User; // the stock Bob shorts
let dave: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara, dave] = await setupPlayers("Alice", "Bob", "Cara", "Dave");
});

const player = (u: User) => getDoc(`players/${u.uid}`);
const notes = async (u: User) => (await listDocs("notifications")).filter((n) => n.uid === u.uid && n.kind === "margin");
const systemPosts = async () => (await listDocs("posts")).filter((p) => p.system).map((p) => p.text as string);

/** Cost to buy back all of Bob's open shorts at the current pools. */
async function bobCoverCost(): Promise<number> {
  const shorts = (await listDocs("shorts")).filter((s) => s.ownerId === bob.uid && s.status === "open");
  let total = 0;
  for (const s of shorts) total += quoteCloseShort(await getDoc(`stocks/${s.stockId}`), s.shares, DEFAULT_CONFIG.tradingFeePct).cost;
  return total;
}

/**
 * Bob buys Dave (£600), shorts Cara (9 shares), then buys Alice (£500): his
 * cash (~£330) is now below the ~£465 it costs to cover, so he's margin called.
 */
async function getBobCalled() {
  await call(bob, "trade", { stockId: dave.uid, side: "buy", amount: 600 });
  const short = await call(bob, "openShort", { stockId: cara.uid, shares: 9 });
  await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 500 });
  const p = await waitFor(async () => {
    const x = await player(bob);
    return x.marginCall ? x : undefined;
  }, 15_000, "Bob's margin call");
  return { short, p };
}

describe("margin warning", () => {
  it("fires once when cover cost reaches shortWarnPct of cash", async () => {
    // Shorting 9 Cara with £1,000: ~£1,400 cash, ~£410 to cover (≈29%).
    await call(alice, "updateConfig", { patch: { shortWarnPct: 0.25 } });
    await call(bob, "openShort", { stockId: cara.uid, shares: 9 });
    const warned = await waitFor(async () => (await player(bob)).marginWarnedAt, 15_000, "marginWarnedAt");
    expect(typeof warned).toBe("number");
    const first = await waitFor(async () => {
      const n = await notes(bob);
      return n.length ? n : undefined;
    });
    expect(first).toHaveLength(1);
    expect(first[0].title).toContain("Margin warning");
    expect(first[0].link).toBe("/portfolio/#margin");
    expect((await player(bob)).marginCall).toBeUndefined();

    // More price moves on Cara while still in "warn": no second warning.
    await call(dave, "trade", { stockId: cara.uid, side: "buy", amount: 20 });
    await call(dave, "trade", { stockId: cara.uid, side: "buy", amount: 20 });
    await sleep(1500);
    expect(await notes(bob)).toHaveLength(1);
    expect((await player(bob)).marginWarnedAt).toBe(warned);
    expect((await listDocs("discordOutbox")).filter((d) => d.kind === "marginWarn")).toHaveLength(1);
  });
});

describe("margin call", () => {
  it("is set with a 7-day deadline, announced, and closeShort refuses with the shortfall", async () => {
    const { short, p } = await getBobCalled();
    const cover = await bobCoverCost();
    expect(p.marginCall.deadline - p.marginCall.calledAt).toBe(MARGIN_CALL_MS);
    expect(p.marginCall.shortfall).toBeCloseTo(cover - p.cash, 1);
    expect(p.marginCall.shortfall).toBeGreaterThan(0);

    const n = await waitFor(async () => (await notes(bob)).find((x) => x.title.includes("Margin call")));
    expect(n.body).toContain("Raise £");
    expect((await systemPosts()).some((t) => t.startsWith("Bob has been margin called: they must raise £"))).toBe(true);
    const discord = (await listDocs("discordOutbox")).find((d) => d.kind === "marginCall");
    expect(discord.priority).toBe("high");

    // Covering now would cost more than Bob's cash: refused, nothing settled.
    let err: CallError | null = null;
    try {
      await call(bob, "closeShort", { shortId: short.id });
    } catch (e) {
      err = e as CallError;
    }
    expect(err?.status).toBe("FAILED_PRECONDITION");
    expect(err?.details).toMatchObject({ reason: "insufficientCash" });
    expect(err?.details.shortfall).toBeCloseTo(p.marginCall.shortfall, 1);
    expect((await getDoc(`shorts/${short.id}`)).status).toBe("open");
    expect((await player(bob)).cash).toBeCloseTo(p.cash, 6);
    expect((await listDocs("holdings")).filter((h) => h.uid === bob.uid)).toHaveLength(2);
  });

  it("clears when the player sells holdings to raise the cash, and then they can cover", async () => {
    const { short } = await getBobCalled();
    await call(bob, "trade", { stockId: dave.uid, side: "sell", amount: (await getDoc(`holdings/${bob.uid}_${dave.uid}`)).shares });
    await waitFor(async () => !(await player(bob)).marginCall, 15_000, "the call to clear");
    expect((await systemPosts()).some((t) => t === "Bob cleared their margin call.")).toBe(true);
    expect((await notes(bob)).some((x) => x.title.includes("cleared"))).toBe(true);
    const closed = await call(bob, "closeShort", { shortId: short.id });
    expect(closed.status).toBe("closed");
  });

  it("clears when the shorted stock's price falls enough", async () => {
    await getBobCalled();
    // Make the shortfall small, then Dave's short pushes Cara's price down.
    const cover = await bobCoverCost();
    await patchDoc(`players/${bob.uid}`, { cash: cover - 5 });
    await call(dave, "openShort", { stockId: cara.uid, shares: 3 });
    await waitFor(async () => !(await player(bob)).marginCall, 15_000, "the call to clear");
    expect((await systemPosts()).some((t) => t === "Bob cleared their margin call.")).toBe(true);
  });

  it("keeps the shortfall current as prices move", async () => {
    const { p } = await getBobCalled();
    // Alice buys Cara: Bob's buy-back gets dearer.
    await call(alice, "trade", { stockId: cara.uid, side: "buy", amount: 200 });
    const later = await waitFor(async () => {
      const x = await player(bob);
      return x.marginCall && x.marginCall.shortfall > p.marginCall.shortfall + 0.01 ? x : undefined;
    }, 15_000, "a larger shortfall");
    expect(later.marginCall.deadline).toBe(p.marginCall.deadline);
    expect(later.marginCall.shortfall).toBeCloseTo((await bobCoverCost()) - later.cash, 1);
  });
});

describe("forced liquidation", () => {
  it("after the deadline sells only enough (largest holding first), covers the short, and says so everywhere", async () => {
    const { short, p } = await getBobCalled();
    const daveHolding = await getDoc(`holdings/${bob.uid}_${dave.uid}`);
    const aliceHolding = await getDoc(`holdings/${bob.uid}_${alice.uid}`);
    // Not due yet: the scheduler leaves it alone.
    await tickScheduler();
    expect((await getDoc(`shorts/${short.id}`)).status).toBe("open");

    await patchDoc(`players/${bob.uid}`, { marginCall: { ...p.marginCall, deadline: Date.now() - 1000 } });
    await tickScheduler();

    expect((await getDoc(`shorts/${short.id}`)).status).toBe("closed");
    const after = await player(bob);
    expect(after.marginCall).toBeUndefined();
    expect(after.isActive).toBe(true);
    expect(after.cash).toBeGreaterThanOrEqual(0);
    expect(after.cash).toBeLessThan(1);

    // Dave was the bigger holding: partly sold. Alice's is untouched.
    const daveAfter = await getDoc(`holdings/${bob.uid}_${dave.uid}`);
    expect(daveAfter.shares).toBeGreaterThan(0);
    expect(daveAfter.shares).toBeLessThan(daveHolding.shares);
    expect((await getDoc(`holdings/${bob.uid}_${alice.uid}`)).shares).toBe(aliceHolding.shares);

    const trades = (await listDocs("trades")).filter((t) => t.traderId === bob.uid);
    const forcedSale = trades.filter((t) => t.kind === "liquidation");
    expect(forcedSale).toHaveLength(1);
    expect(forcedSale[0]).toMatchObject({ stockId: dave.uid, side: "sell" });
    expect(forcedSale[0].fee).toBeCloseTo(forcedSale[0].cashAmount * DEFAULT_CONFIG.tradingFeePct, 9);
    expect(trades.filter((t) => t.kind === "closeShort" && t.forced)).toHaveLength(1);

    const post = (await systemPosts()).find((t) => t.startsWith("Bob was force-liquidated"));
    expect(post).toMatch(/^Bob was force-liquidated to cover a short on Cara: sold Dave \(£[\d.,]+\) for £[\d.,]+\.$/);
    expect((await notes(bob)).some((x) => x.title.includes("Forced sale"))).toBe(true);
    expect((await listDocs("discordOutbox")).find((d) => d.kind === "liquidation").priority).toBe("high");
    expect((await listDocs("auditLog")).find((e) => e.action === "forcedLiquidation")).toMatchObject({ actorId: "system", targetId: bob.uid });

    // The weekly report lists it.
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const report = await getDoc("weeklyReports/week-0001");
    expect(report.highlights.liquidations).toHaveLength(1);
    expect(report.highlights.liquidations[0]).toMatchObject({ playerId: bob.uid, name: "Bob", covered: ["Cara"], bankrupt: false });
    expect(report.highlights.liquidations[0].sold[0].stockName).toBe("Dave");
    expect(report.markdown).toContain("## Forced liquidations");
    expect(report.markdown).toContain("**Bob** was force-liquidated to cover short on Cara: sold Dave");
  });

  it("falls back to bankruptcy when even selling everything can't cover it", async () => {
    await call(bob, "trade", { stockId: dave.uid, side: "buy", amount: 50 });
    const short = await call(bob, "openShort", { stockId: cara.uid, shares: 9 });
    await patchDoc(`players/${bob.uid}`, { cash: 10 });
    // Any trade on Cara re-evaluates Bob (he's short it).
    await call(dave, "trade", { stockId: cara.uid, side: "buy", amount: 1 });
    const p = await waitFor(async () => {
      const x = await player(bob);
      return x.marginCall ? x : undefined;
    }, 15_000, "Bob's margin call");
    await patchDoc(`players/${bob.uid}`, { marginCall: { ...p.marginCall, deadline: Date.now() - 1000 } });
    await tickScheduler();

    const after = await player(bob);
    expect(after.isActive).toBe(false);
    expect(typeof after.bankruptAt).toBe("number");
    expect(after.cash).toBe(0);
    expect(after.marginCall).toBeUndefined();
    expect((await getDoc(`shorts/${short.id}`)).status).toBe("closed");
    // Everything was sold.
    expect((await listDocs("holdings")).filter((h) => h.uid === bob.uid)).toEqual([]);
    expect((await listDocs("trades")).filter((t) => t.traderId === bob.uid && t.kind === "liquidation")).toHaveLength(1);
    expect((await systemPosts()).some((t) => t.startsWith("Bob was force-liquidated") && t.includes("bankrupt"))).toBe(true);
    const kinds = (await listDocs("discordOutbox")).map((d) => d.kind);
    expect(kinds).toContain("bankruptcy");
    expect(kinds).toContain("liquidation");

    // Reactivated at the next close, as before.
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    expect((await player(bob)).isActive).toBe(true);
    const report = await getDoc("weeklyReports/week-0001");
    expect(report.highlights.liquidations[0]).toMatchObject({ playerId: bob.uid, bankrupt: true });
  });

  it("re-checks at the deadline and doesn't sell if the call was already covered", async () => {
    const { short, p } = await getBobCalled();
    const cover = await bobCoverCost();
    // Cash arrives without a trade (the trigger hasn't re-evaluated yet).
    await patchDoc(`players/${bob.uid}`, { cash: cover + 50, marginCall: { ...p.marginCall, deadline: Date.now() - 1000 } });
    await tickScheduler();
    expect((await getDoc(`shorts/${short.id}`)).status).toBe("open");
    expect((await player(bob)).marginCall).toBeUndefined();
    expect((await listDocs("trades")).filter((t) => t.kind === "liquidation")).toEqual([]);
  });
});

describe("weekly close and margin", () => {
  it("re-evaluates after allowances and bonuses are paid", async () => {
    const { p } = await getBobCalled();
    // A shortfall smaller than the weekly allowance: the close clears it.
    const cover = await bobCoverCost();
    await patchDoc(`players/${bob.uid}`, { cash: cover - DEFAULT_CONFIG.weeklyAllowance / 2, marginCall: { ...p.marginCall, shortfall: DEFAULT_CONFIG.weeklyAllowance / 2 } });
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    expect((await player(bob)).marginCall).toBeUndefined();
    expect((await systemPosts()).some((t) => t === "Bob cleared their margin call.")).toBe(true);
  });
});
