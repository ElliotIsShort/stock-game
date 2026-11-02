import { describe, expect, it } from "vitest";
import { quoteCloseShort, quoteSell } from "../src";
import { MARGIN_CALL_MS, ceilPenny, coverCost, marginStatus, nextMarginFlags, planLiquidation, type MarginStatus } from "../src/margin";
import { summariseLiquidations, reportToMarkdown } from "../src/report";

const FEE = 0.015;
const cfg = { tradingFeePct: FEE, shortWarnPct: 0.8 };
// A £50 stock with a £2,000 pool.
const pool = { poolCash: 2000, poolShares: 40 };
const pools = new Map([["bob", pool], ["cara", { poolCash: 4000, poolShares: 100 }], ["dave", { poolCash: 1000, poolShares: 50 }]]);
const poolOf = (id: string) => pools.get(id);
const cost5 = quoteCloseShort(pool, 5, FEE).cost; // ≈ £290

describe("marginStatus", () => {
  it("is ok with no shorts, whatever the cash", () => {
    expect(marginStatus(0, [], poolOf, cfg)).toMatchObject({ level: "ok", coverCost: 0, shortfall: 0 });
  });

  it("is ok below the warning threshold, warn from it up to cash, call above cash", () => {
    expect(marginStatus(cost5 / 0.79, [{ stockId: "bob", shares: 5 }], poolOf, cfg).level).toBe("ok");
    expect(marginStatus(cost5 / 0.8, [{ stockId: "bob", shares: 5 }], poolOf, cfg).level).toBe("warn");
    expect(marginStatus(cost5, [{ stockId: "bob", shares: 5 }], poolOf, cfg).level).toBe("warn");
    const call = marginStatus(cost5 - 10, [{ stockId: "bob", shares: 5 }], poolOf, cfg);
    expect(call.level).toBe("call");
    expect(call.shortfall).toBe(ceilPenny(10));
    expect(call.coverCost).toBeCloseTo(cost5, 9);
  });

  it("treats a short the pool can't cover as a call", () => {
    const s = marginStatus(1e9, [{ stockId: "bob", shares: 40 }], poolOf, cfg);
    expect(s.level).toBe("call");
    expect(s.uncoverable).toEqual(["bob"]);
    expect(marginStatus(1e9, [{ stockId: "gone", shares: 1 }], poolOf, cfg).level).toBe("call");
  });

  it("prices several shorts on one stock as one buy-back (same as closing them in turn)", () => {
    const together = coverCost([{ stockId: "bob", shares: 2 }, { stockId: "bob", shares: 3 }], poolOf, FEE).cost;
    const first = quoteCloseShort(pool, 2, FEE);
    const second = quoteCloseShort({ poolCash: first.newPoolCash, poolShares: first.newPoolShares }, 3, FEE);
    expect(together).toBeCloseTo(first.cost + second.cost, 9);
    expect(together).toBeCloseTo(cost5, 9);
  });

  it("rounds the shortfall up to the penny", () => {
    expect(ceilPenny(10.001)).toBe(10.01);
    expect(ceilPenny(10)).toBe(10);
  });
});

describe("margin flags", () => {
  const status = (level: MarginStatus["level"], shortfall = 0): MarginStatus => ({ level, coverCost: 100, cash: 90, shortfall, uncoverable: [] });

  it("warns once on ok → warn, and again only after returning to ok", () => {
    const warned = nextMarginFlags({}, status("warn"), 1);
    expect(warned).toMatchObject({ event: "warned", changed: true, flags: { marginWarnedAt: 1 } });
    expect(nextMarginFlags(warned.flags, status("warn"), 2)).toMatchObject({ event: null, changed: false });
    const back = nextMarginFlags(warned.flags, status("ok"), 3);
    expect(back).toMatchObject({ event: null, changed: true, flags: {} });
    expect(nextMarginFlags(back.flags, status("warn"), 4).event).toBe("warned");
  });

  it("calls with a 7-day deadline, tracks the shortfall, and clears", () => {
    const called = nextMarginFlags({}, status("call", 10), 1000);
    expect(called.event).toBe("called");
    expect(called.flags.marginCall).toEqual({ calledAt: 1000, deadline: 1000 + MARGIN_CALL_MS, shortfall: 10, coverCost: 100 });
    // Prices move: the shortfall updates, the deadline doesn't.
    const moved = nextMarginFlags(called.flags, status("call", 25), 5000);
    expect(moved).toMatchObject({ event: null, changed: true });
    expect(moved.flags.marginCall).toMatchObject({ calledAt: 1000, deadline: 1000 + MARGIN_CALL_MS, shortfall: 25 });
    expect(nextMarginFlags(moved.flags, status("call", 25.004), 6000).changed).toBe(false);
    // Back to warn clears the call without a fresh warning.
    expect(nextMarginFlags(moved.flags, status("warn"), 7000)).toMatchObject({ event: "cleared", flags: { marginWarnedAt: 1000 } });
    expect(nextMarginFlags(moved.flags, status("ok"), 7000)).toMatchObject({ event: "cleared", flags: {} });
  });
});

describe("planLiquidation", () => {
  const shorts = [{ stockId: "bob", shares: 5 }];

  it("sells nothing when cash already covers the shorts", () => {
    expect(planLiquidation(cost5 + 1, [{ stockId: "cara", shares: 10 }], shorts, poolOf, FEE)).toMatchObject({ sales: [], solvent: true });
  });

  it("sells the largest holding first, and only as much as needed", () => {
    // Cara holding worth £400, Dave holding worth £200; short by £100.
    const plan = planLiquidation(cost5 - 100, [{ stockId: "dave", shares: 10 }, { stockId: "cara", shares: 10 }], shorts, poolOf, FEE);
    expect(plan.sales).toHaveLength(1);
    expect(plan.sales[0]).toMatchObject({ stockId: "cara", all: false });
    expect(plan.sales[0].shares).toBeLessThan(10);
    expect(plan.sales[0].netCash).toBeGreaterThanOrEqual(100);
    expect(plan.sales[0].netCash).toBeLessThan(100.05);
    expect(plan.solvent).toBe(true);
    expect(plan.cashAfter).toBeGreaterThanOrEqual(plan.coverCost);
    // Same quote and fee as a normal sell.
    const q = quoteSell(pools.get("cara")!, plan.sales[0].shares, FEE);
    expect(plan.sales[0].fee).toBeCloseTo(q.fee, 9);
  });

  it("moves on to the next holding when the first isn't enough", () => {
    const plan = planLiquidation(cost5 - 450, [{ stockId: "dave", shares: 10 }, { stockId: "cara", shares: 10 }], shorts, poolOf, FEE);
    expect(plan.sales.map((s) => [s.stockId, s.all])).toEqual([["cara", true], ["dave", false]]);
    expect(plan.solvent).toBe(true);
  });

  it("reports insolvency when selling everything isn't enough", () => {
    const plan = planLiquidation(0, [{ stockId: "dave", shares: 1 }], shorts, poolOf, FEE);
    expect(plan.sales).toHaveLength(1);
    expect(plan.sales[0].all).toBe(true);
    expect(plan.solvent).toBe(false);
  });

  it("selling a stock you're also short makes covering it cheaper", () => {
    const plan = planLiquidation(cost5 - 50, [{ stockId: "bob", shares: 3 }], shorts, poolOf, FEE);
    expect(plan.solvent).toBe(true);
    expect(plan.coverCost).toBeLessThan(cost5);
  });
});

describe("liquidation summaries", () => {
  it("groups forced sales and covers per event and renders a report section", () => {
    const at = 5000;
    const trades = [
      { traderId: "u1", traderName: "Ann", stockName: "Cara", kind: "liquidation", shares: 2, netCash: 80, createdAt: at },
      { traderId: "u1", traderName: "Ann", stockName: "Dave", kind: "liquidation", shares: 1, netCash: 120, createdAt: at },
      { traderId: "u1", traderName: "Ann", stockName: "Bob", kind: "closeShort", forced: true, shares: 5, netCash: -290, createdAt: at },
      { traderId: "u2", traderName: "Ben", stockName: "Bob", kind: "closeShort", shares: 1, netCash: -50, createdAt: at },
      { traderId: "u2", traderName: "Ben", stockName: "Bob", shares: 1, netCash: -50, createdAt: at },
    ];
    const rows = summariseLiquidations(trades, () => undefined);
    expect(rows).toEqual([
      { playerId: "u1", name: "Ann", at, sold: [{ stockName: "Dave", shares: 1, cash: 120 }, { stockName: "Cara", shares: 2, cash: 80 }], raised: 200, covered: ["Bob"], bankrupt: false },
    ]);
    expect(summariseLiquidations(trades, (id) => (id === "u1" ? at : undefined))[0].bankrupt).toBe(true);
  });

  it("old reports without liquidations still render", () => {
    const base = {
      id: "week-0001", week: 1, periodStart: 0, periodEnd: 1, generatedAt: 1, trigger: "admin" as const, settings: {} as never, explainer: "",
      money: { totalCash: 0, totalStockValue: 0, totalNetWorth: 0, allowancesPaid: 0, bonusesPaid: 0, poolTopUps: 0, feesCollected: 0, prizePoolBeforePayout: 0, prizePaid: 0, cashPct: 0, stockPct: 0 },
      prices: { medianPrice: 0, index: 100, stocks: [] },
      health: { avgMovePerTrade: 0, largestMoves: [], avgNetWorth: 0, targetPoolCash: 0, wealthTop: 0, wealthBottom: 0, wealthGap: 0 },
      activity: { totalPlayers: 0, activePlayers: 0, idlePlayers: 0, newlyIdle: [], tradeCount: 0, postCount: 0, linkedTradePct: 0 },
      highlights: { leaderboard: [], growth: [], winners: [], biggestGainers: [], biggestLosers: [], topPosts: [] },
      flags: [], snapshot: [], summary: {}, changes: {},
    };
    const settings = { weeklyAllowance: 200, tradingFeePct: FEE, bonusRate: 0.01, targetTradeSize: 0.1, targetImpact: 0.05, baseStartingCash: 1000, baseStockPrice: 50, idleThresholdWeeks: 4, prizeSplitPct: [1] };
    expect(reportToMarkdown({ ...base, settings: settings as never })).not.toContain("Forced liquidations");
    const md = reportToMarkdown({
      ...base,
      settings: settings as never,
      highlights: { ...base.highlights, liquidations: [{ playerId: "u1", name: "Ann", at: 1, sold: [{ stockName: "Cara", shares: 2, cash: 80 }], raised: 80, covered: ["Bob"], bankrupt: false }] },
    });
    expect(md).toContain("## Forced liquidations");
    expect(md).toContain("**Ann** was force-liquidated to cover short on Bob: sold Cara (£80.00) for £80.00");
  });
});
