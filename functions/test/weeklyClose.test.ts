import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, WEEK_MS, targetPoolCash } from "@fsm/shared";
import { call, cron, cronSecret, expectCallError, getDoc, listDocs, patchDoc, setupPlayers, signUp, wipeEmulators, type User } from "./helpers";

let alice: User;
let bob: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob] = await setupPlayers("Alice", "Bob");
});

const { weeklyAllowance, bonusRate, tradingFeePct } = DEFAULT_CONFIG;

describe("weekly close (§6)", () => {
  it("pays allowances, CEO bonus and the prize, then stores a report", async () => {
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 300 });
    const holding = await getDoc(`holdings/${bob.uid}_${alice.uid}`);
    const aliceStock = await getDoc(`stocks/${alice.uid}`);
    const fee = 300 * tradingFeePct;

    const res = await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    expect(res).toMatchObject({ closed: true, week: 1, reportId: "week-0001" });
    expect(res.prize).toBeCloseTo(fee, 9);
    // Two eligible players: the 60/25 split is rescaled to 60/85 and 25/85.
    expect(res.winners.map((w: { name: string }) => w.name)).toEqual(["Bob", "Alice"]);
    const bobShare = (fee * 0.6) / 0.85;
    const aliceShare = (fee * 0.25) / 0.85;

    const a = await getDoc(`players/${alice.uid}`);
    const b = await getDoc(`players/${bob.uid}`);
    const bonus = bonusRate * holding.shares * aliceStock.price;
    // Alice: allowance + CEO bonus on the value Bob holds + second place.
    expect(a.totalAllowances).toBe(weeklyAllowance);
    expect(a.totalBonus).toBeCloseTo(bonus, 9);
    expect(a.cash).toBeCloseTo(1000 + weeklyAllowance + bonus + aliceShare, 6);
    // Bob: allowance + first place (he had the best growth from his mark-to-market gain).
    expect(b.cash).toBeCloseTo(700 + weeklyAllowance + bobShare, 6);
    expect(b.totalBonus).toBe(0);
    // Next week's baseline is the post-payout net worth.
    expect(b.netWorthWeekStart).toBeCloseTo(b.cash + holding.shares * aliceStock.price, 6);

    const state = await getDoc("meta/state");
    expect(state).toMatchObject({ currentWeek: 2, prizePool: 0, weekFees: 0 });

    // Net-worth history gets one point per close, matching the new week-start baseline.
    const hist = await getDoc(`netWorthHistory/${bob.uid}`);
    expect(hist.points).toHaveLength(1);
    expect(hist.points[0]).toMatchObject({ week: 1 });
    expect(hist.points[0].v).toBeCloseTo(b.netWorthWeekStart, 6);

    const report = await getDoc("weeklyReports/week-0001");
    expect(report.activity.tradeCount).toBe(1);
    expect(report.money.allowancesPaid).toBe(2 * weeklyAllowance);
    expect(report.money.feesCollected).toBeCloseTo(fee, 9);
    expect(report.highlights.winners.map((w: { name: string }) => w.name)).toEqual(["Bob", "Alice"]);
    expect(report.highlights.winners[0].prizeAmount).toBeCloseTo(bobShare, 9);
    expect(report.highlights.winners[1].prizeAmount).toBeCloseTo(aliceShare, 9);
    expect(report.markdown).toContain("# Stonker — Week 1 report");

    // Weekly price stats reset for the new week.
    const s = await getDoc(`stocks/${alice.uid}`);
    expect(s).toMatchObject({ weekTradeCount: 0, weekOpenPrice: s.price, weekHigh: s.price, weekLow: s.price });
  });

  it("can't close the same week twice (double-click protection)", async () => {
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    await expectCallError(call(alice, "runWeeklyClose", { expectedWeek: 1 }), "FAILED_PRECONDITION");
    await expectCallError(call(bob, "runWeeklyClose", { expectedWeek: 2 }), "PERMISSION_DENIED");
  });

  it("week 2's report shows changes from week 1", async () => {
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    await call(alice, "runWeeklyClose", { expectedWeek: 2 });
    const r2 = await getDoc("weeklyReports/week-0002");
    expect(typeof r2.changes.totalCash).toBe("number");
  });

  it("tops up pools to the new depth target without moving price (§2.1)", async () => {
    await call(alice, "updateConfig", { patch: { targetTradeSize: 0.5 } });
    const before = await getDoc(`stocks/${bob.uid}`);
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const after = await getDoc(`stocks/${bob.uid}`);
    // Both players end the week on 1000 + allowance.
    const target = targetPoolCash(1000 + weeklyAllowance, 0.5, DEFAULT_CONFIG.targetImpact);
    expect(after.poolCash).toBeCloseTo(target, 6);
    expect(after.poolCash).toBeGreaterThan(before.poolCash);
    expect(after.price).toBeCloseTo(before.price, 9);
  });

  it("idle players get no allowance and can't win; signing in reactivates them (§5)", async () => {
    await patchDoc(`players/${bob.uid}`, { lastActiveAt: Date.now() - 5 * WEEK_MS });
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const b = await getDoc(`players/${bob.uid}`);
    expect(b.isIdle).toBe(true);
    expect(b.cash).toBe(1000);
    expect(b.totalAllowances).toBe(0);
    const report = await getDoc("weeklyReports/week-0001");
    expect(report.activity.newlyIdle).toEqual(["Bob"]);
    expect(report.highlights.winners.map((w: { playerId: string }) => w.playerId)).toEqual([alice.uid]);

    expect(await call(bob, "touch")).toMatchObject({ player: true, reactivated: true });
    expect((await getDoc(`players/${bob.uid}`)).isIdle).toBe(false);
  });
});

describe("weekly prize split", () => {
  interface Winner {
    playerId: string;
    name: string;
    growth: number;
    prizeAmount: number;
  }

  it("pays the whole prize pool to the top 3 eligible growers, 60/25/15", async () => {
    const [cara, dave, erin] = await setupMore("Cara", "Dave", "Erin");
    // Dave's buy funds the pool with a real trading fee.
    await call(dave, "trade", { stockId: alice.uid, side: "buy", amount: 400 });
    // Engineer the ranking via week-start baselines: with no trades of their own,
    // growth = (1000 − start) / start. Erin would top it but is idle, so she's ineligible.
    await patchDoc(`players/${alice.uid}`, { netWorthWeekStart: 800 }); // +25%
    await patchDoc(`players/${bob.uid}`, { netWorthWeekStart: 850 }); // +17.6%
    await patchDoc(`players/${cara.uid}`, { netWorthWeekStart: 900 }); // +11.1%
    await patchDoc(`players/${erin.uid}`, { netWorthWeekStart: 500, lastActiveAt: Date.now() - 5 * WEEK_MS }); // +100%, idle

    const pool = (await getDoc("meta/state")).prizePool;
    expect(pool).toBeCloseTo(400 * tradingFeePct, 9);

    const res = await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const winners = res.winners as Winner[];
    expect(winners.map((w) => w.playerId)).toEqual([alice.uid, bob.uid, cara.uid]);
    expect(winners[0].prizeAmount).toBeCloseTo(pool * 0.6, 9);
    expect(winners[1].prizeAmount).toBeCloseTo(pool * 0.25, 9);
    expect(winners[2].prizeAmount).toBeCloseTo(pool * 0.15, 9);
    expect(winners.reduce((a, w) => a + w.prizeAmount, 0)).toBeCloseTo(pool, 9);
    expect(res.prize).toBe(pool);

    // Cash: allowance (+ CEO bonus for Alice, whose stock Dave holds) + their share.
    const a = await getDoc(`players/${alice.uid}`);
    expect(a.cash).toBeCloseTo(1000 + weeklyAllowance + a.totalBonus + pool * 0.6, 6);
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeCloseTo(1000 + weeklyAllowance + pool * 0.25, 6);
    expect((await getDoc(`players/${cara.uid}`)).cash).toBeCloseTo(1000 + weeklyAllowance + pool * 0.15, 6);
    // Fourth place and the idle player get nothing from the pool.
    expect((await getDoc(`players/${dave.uid}`)).cash).toBeCloseTo(600 + weeklyAllowance, 6);
    expect((await getDoc(`players/${erin.uid}`)).cash).toBe(1000);

    // The pool is drained exactly.
    expect((await getDoc("meta/state")).prizePool).toBe(0);

    const report = await getDoc("weeklyReports/week-0001");
    expect(report.money.prizePaid).toBe(pool);
    expect(report.highlights.winners).toHaveLength(3);
    for (const [i, w] of (report.highlights.winners as Winner[]).entries()) {
      expect(w).toMatchObject({ playerId: winners[i].playerId, name: winners[i].name });
      expect(w.prizeAmount).toBeCloseTo(winners[i].prizeAmount, 9);
    }
    expect(report.markdown).toContain("paid to 3 winners");
    for (const name of ["Alice", "Bob", "Cara"]) expect(report.markdown).toContain(`**${name}**`);

    const sysPost = (await listDocs("posts")).find((p) => p.system && p.text.startsWith("Week 1 closed"));
    expect(sysPost.text).toContain("1. Alice");
    expect(sysPost.text).toContain("3. Cara");
  });

  it("rolls the pool over untouched when nobody is eligible", async () => {
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 300 });
    const pool = (await getDoc("meta/state")).prizePool;
    const longAgo = Date.now() - 5 * WEEK_MS;
    await patchDoc(`players/${alice.uid}`, { lastActiveAt: longAgo });
    await patchDoc(`players/${bob.uid}`, { lastActiveAt: longAgo });

    const res = await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    expect(res.winners).toEqual([]);
    expect(res.prize).toBe(0);
    expect((await getDoc("meta/state")).prizePool).toBeCloseTo(pool, 9);
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeCloseTo(700, 6);
    const report = await getDoc("weeklyReports/week-0001");
    expect(report.highlights.winners).toEqual([]);
    expect(report.markdown).toContain("no eligible winner; the prize pool rolls over");
  });

  it("uses the configured split, and rejects invalid ones", async () => {
    const after = await call(alice, "updateConfig", { patch: { prizeSplitPct: [1] } });
    expect(after.prizeSplitPct).toEqual([1]);
    expect((await getDoc("config/global")).prizeSplitPct).toEqual([1]);
    await expectCallError(call(alice, "updateConfig", { patch: { prizeSplitPct: [0.5, -0.5] } }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "updateConfig", { patch: { prizeSplitPct: [] } }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "updateConfig", { patch: { prizeSplitPct: "0.6,0.4" } }), "INVALID_ARGUMENT");

    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 300 });
    const pool = (await getDoc("meta/state")).prizePool;
    const res = await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    // Winner-take-all again: only Bob, with the whole pool.
    expect(res.winners).toHaveLength(1);
    expect(res.winners[0]).toMatchObject({ playerId: bob.uid, prizeAmount: pool });
  });
});

/** Register and approve extra players on top of Alice (admin) and Bob. */
async function setupMore(...names: string[]): Promise<User[]> {
  const users: User[] = [];
  for (const name of names) {
    const u = await signUp(name);
    await call(u, "register", { displayName: name });
    await call(alice, "approvePlayer", { uid: u.uid });
    users.push(u);
  }
  return users;
}

describe("weeklyCloseCron endpoint", () => {
  it("rejects missing or wrong secrets and non-POST requests", async () => {
    expect((await cron(null)).status).toBe(401);
    expect((await cron("wrong-secret-wrong-secret")).status).toBe(401);
    expect((await cron(cronSecret(), "GET")).status).toBe(405);
    expect((await getDoc("meta/state")).currentWeek).toBe(1);
  });

  it("closes the week, then skips if called again too soon", async () => {
    const first = await (await cron(cronSecret())).json();
    expect(first).toMatchObject({ closed: true, week: 1 });
    const second = await (await cron(cronSecret())).json();
    expect(second.closed).toBe(false);
    expect(second.reason).toContain("min");
    expect((await getDoc("meta/state")).currentWeek).toBe(2);
  });
});
