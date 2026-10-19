import { describe, expect, it } from "vitest";
import {
  WEEK_MS,
  ceoBonus,
  isIdleSince,
  leaderboardScore,
  listingPrice,
  mean,
  median,
  netWorth,
  startingCash,
  weeklyGrowth,
} from "../src/economy";

const cfg = { baseStartingCash: 1000, weeklyAllowance: 200 };

describe("startingCash (§4.1)", () => {
  it("gives founders the base amount", () => {
    expect(startingCash(1, cfg)).toBe(1000);
  });
  it("adds one allowance per elapsed week for later joiners", () => {
    expect(startingCash(2, cfg)).toBe(1200);
    expect(startingCash(5, cfg)).toBe(1800);
  });
  it("never goes below base for odd inputs", () => {
    expect(startingCash(0, cfg)).toBe(1000);
  });
});

describe("listing price (§4.2)", () => {
  it("uses the base price when nothing is listed", () => {
    expect(listingPrice([], 50)).toBe(50);
  });
  it("uses the median, which resists one runaway stock", () => {
    expect(listingPrice([40, 50, 1000], 50)).toBe(50);
    expect(listingPrice([40, 60], 50)).toBe(50);
  });
  it("median/mean handle empty input", () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
  });
});

describe("netWorth", () => {
  it("marks holdings at the current price and ignores unknown/delisted stocks", () => {
    const prices: Record<string, number> = { a: 10, b: 2.5 };
    const nw = netWorth(100, [{ stockId: "a", shares: 3 }, { stockId: "b", shares: 4 }, { stockId: "gone", shares: 99 }], (id) => prices[id]);
    expect(nw).toBe(100 + 30 + 10);
  });
});

describe("leaderboard + weekly prize (§5)", () => {
  it("everyone starts at a score of 1.00", () => {
    expect(leaderboardScore(1000, 1000, 0)).toBe(1);
    expect(leaderboardScore(1400, 1200, 200)).toBe(1);
  });
  it("counts the CEO bonus as growth (it's in net worth, not the denominator)", () => {
    expect(leaderboardScore(1050, 1000, 0)).toBeCloseTo(1.05, 9);
  });
  it("weekly growth excludes that week's allowance", () => {
    expect(weeklyGrowth(1000, 1200, 200)).toBe(0);
    expect(weeklyGrowth(1000, 1300, 200)).toBeCloseTo(0.1, 9);
    expect(weeklyGrowth(0, 500, 0)).toBe(0);
  });
});

describe("CEO bonus (§3)", () => {
  it("is bonusRate × shares held by others × price", () => {
    expect(ceoBonus(20, 50, 0.01)).toBeCloseTo(10, 9);
    expect(ceoBonus(0, 50, 0.01)).toBe(0);
  });
});

describe("idle flag (§5)", () => {
  const now = 100 * WEEK_MS;
  it("flags players inactive for the threshold", () => {
    expect(isIdleSince(now - 4 * WEEK_MS, now, 4)).toBe(true);
    expect(isIdleSince(now - 4 * WEEK_MS + 1, now, 4)).toBe(false);
  });
});
