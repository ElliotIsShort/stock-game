import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { mechanicsExplainer, reportToMarkdown, reportWinners, type WeeklyReport } from "../src/report";

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
      winners: [
        { playerId: "b", name: "Bob", growth: 0.02, prizeAmount: 2.7 },
        { playerId: "a", name: "Alice", growth: 0.01, prizeAmount: 1.13 },
        { playerId: "c", name: "Carol", growth: -0.01, prizeAmount: 0.67 },
      ],
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

  it("shows prior-week changes, the winners and flags", () => {
    expect(md).toContain("vs prior week");
    expect(md).toContain("**Bob**");
    expect(md).toContain("[bigMove] Alice moved 60% this week.");
    expect(md).toContain("| Alice | £50.00 | £55.00 |");
  });

  it("lists every prize winner in rank order with their amount", () => {
    expect(md).toContain("- Weekly prize (£4.50 paid to 3 winners):");
    const lines = md.split("\n");
    const first = lines.indexOf("  1. **Bob** with 2.00% growth, won £2.70");
    expect(first).toBeGreaterThan(-1);
    expect(lines[first + 1]).toBe("  2. **Alice** with 1.00% growth, won £1.13");
    expect(lines[first + 2]).toBe("  3. **Carol** with -1.00% growth, won £0.67");
  });

  it("uses singular wording for one winner and says when the pool rolls over", () => {
    const one = sampleReport();
    one.highlights.winners = [{ playerId: "b", name: "Bob", growth: 0.02, prizeAmount: 4.5 }];
    expect(reportToMarkdown(one)).toContain("- Weekly prize (£4.50 paid to 1 winner):");

    const none = sampleReport();
    none.highlights.winners = [];
    none.money.prizePaid = 0;
    const noneMd = reportToMarkdown(none);
    expect(noneMd).toContain("- Weekly prize: no eligible winner; the prize pool rolls over");
    expect(noneMd).not.toContain("won £");
  });

  it("includes the prize split in the settings snapshot and the explainer", () => {
    expect(md).toContain("- Weekly prize split: 60.00% / 25.00% / 15.00%");
    expect(md).toContain("split among the top 3 players by weekly growth (60.00% / 25.00% / 15.00%)");
    expect(mechanicsExplainer({ ...DEFAULT_CONFIG, prizeSplitPct: [1] })).toContain("the whole prize pool goes to the player with the highest weekly growth");
  });
});

describe("reportWinners", () => {
  it("returns the winners of a current report", () => {
    expect(reportWinners(sampleReport()).map((w) => w.name)).toEqual(["Bob", "Alice", "Carol"]);
  });

  it("maps a pre-split report's single winner", () => {
    const legacy = { highlights: { winner: { uid: "b", name: "Bob", weeklyGrowth: 0.02, prize: 4.5 } } } as never;
    expect(reportWinners(legacy)).toEqual([{ playerId: "b", name: "Bob", growth: 0.02, prizeAmount: 4.5 }]);
    expect(reportWinners({ highlights: { winner: null } } as never)).toEqual([]);
  });
});
