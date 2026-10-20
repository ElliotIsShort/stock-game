import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, WEEK_MS, targetPoolCash } from "@fsm/shared";
import { call, cron, cronSecret, expectCallError, getDoc, patchDoc, setupPlayers, wipeEmulators, type User } from "./helpers";

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
    expect(res).toMatchObject({ closed: true, week: 1, reportId: "week-0001", winner: "Bob" });
    expect(res.prize).toBeCloseTo(fee, 9);

    const a = await getDoc(`players/${alice.uid}`);
    const b = await getDoc(`players/${bob.uid}`);
    const bonus = bonusRate * holding.shares * aliceStock.price;
    // Alice: allowance + CEO bonus on the value Bob holds.
    expect(a.totalAllowances).toBe(weeklyAllowance);
    expect(a.totalBonus).toBeCloseTo(bonus, 9);
    expect(a.cash).toBeCloseTo(1000 + weeklyAllowance + bonus, 6);
    // Bob: allowance + prize (he had the best growth from his mark-to-market gain).
    expect(b.cash).toBeCloseTo(700 + weeklyAllowance + fee, 6);
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
    expect(report.highlights.winner.name).toBe("Bob");
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
    expect(report.highlights.winner?.uid).not.toBe(bob.uid);

    expect(await call(bob, "touch")).toMatchObject({ player: true, reactivated: true });
    expect((await getDoc(`players/${bob.uid}`)).isIdle).toBe(false);
  });
});

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
