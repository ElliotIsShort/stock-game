import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { mechanicsExplainer, reportToMarkdown, type WeeklyReport } from "../src/report";

function sampleReport(): Omit<WeeklyReport, "markdown"> {
  return {
    id: "week-0001",
    week: 1,
    periodStart: Date.UTC(2026, 0, 1),
    periodEnd: Date.UTC(2026, 0, 8),
    generatedAt: Date.UTC(2026, 0, 8),
    trigger: "admin",
    settings: DEFAULT_CONFIG,
    explainer: mechanicsExplainer(DEFAULT_CONFIG),
    money: {
      totalCash: 1900, totalStockValue: 300, totalNetWorth: 2200, allowancesPaid: 400, bonusesPaid: 3,
      poolTopUps: 0, feesCollected: 4.5, prizePoolBeforePayout: 4.5, prizePaid: 4.5, cashPct: 0.86, stockPct: 0.14,
    },
    prices: {
      medianPrice: 50, index: 104,
      stocks: [{ stockId: "a", name: "Alice", open: 50, close: 55, high: 56, low: 50, pctChange: 0.1, tradeCount: 2, poolCash: 4000, toppedUpCash: 0 }],
    },
    health: { avgMovePerTrade: 0.03, largestMoves: [], avgNetWorth: 1100, targetPoolCash: 4400, wealthTop: 1200, wealthBottom: 1000, wealthGap: 200 },
    activity: { totalPlayers: 2, activePlayers: 2, idlePlayers: 0, newlyIdle: [], tradeCount: 2, postCount: 1, linkedTradePct: 0.5 },
    highlights: {
      leaderboard: [{ uid: "b", name: "Bob", score: 1.02, netWorth: 1220, isIdle: false }],
      growth: [],
      winner: { uid: "b", name: "Bob", weeklyGrowth: 0.02, prize: 4.5 },
      biggestGainers: [{ name: "Alice", pctChange: 0.1 }],
      biggestLosers: [],
      topPosts: [],
    },
    flags: [{ type: "bigMove", message: "Alice moved 60% this week." }],
    snapshot: [],
    summary: { totalCash: 1900 },
    changes: { totalCash: 100 },
  };
}

describe("weekly report markdown (§6.1)", () => {
  const md = reportToMarkdown(sampleReport());

  it("is self-contained: includes the explainer and settings", () => {
    expect(md).toContain("## How the game works");
    expect(md).toContain("## Settings snapshot");
    expect(md).toContain("Trading fee: 1.50%");
  });

  it("includes every required section", () => {
    for (const h of ["## Money", "## Prices", "## Market health", "## Activity", "## Highlights", "## Flags"]) expect(md).toContain(h);
  });

  it("shows prior-week changes, the winner and flags", () => {
    expect(md).toContain("vs prior week");
    expect(md).toContain("**Bob**");
    expect(md).toContain("[bigMove] Alice moved 60% this week.");
    expect(md).toContain("| Alice | £50.00 | £55.00 |");
  });
});
