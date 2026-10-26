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
  prizeSplit,
  startingCash,
  weeklyGrowth,
  weeklyPrizeWinners,
  type PrizeCandidate,
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

describe("weekly prize split (§5)", () => {
  const split = [0.6, 0.25, 0.15];
  const candidate = (playerId: string, growth: number, extra: Partial<PrizeCandidate> = {}): PrizeCandidate => ({
    playerId,
    name: playerId.toUpperCase(),
    growth,
    netWorthStart: 1000,
    isIdle: false,
    ...extra,
  });
  const total = (ws: { prizeAmount: number }[]) => ws.reduce((a, w) => a + w.prizeAmount, 0);

  it("rescales the split entries actually used so they sum to 1", () => {
    expect(prizeSplit(0, split)).toEqual([]);
    expect(prizeSplit(1, split)).toEqual([1]);
    const two = prizeSplit(2, split);
    expect(two[0]).toBeCloseTo(0.6 / 0.85, 12);
    expect(two[1]).toBeCloseTo(0.25 / 0.85, 12);
    const many = prizeSplit(10, split);
    expect(many).toHaveLength(3);
    expect(many[0]).toBeCloseTo(0.6, 12);
    expect(many[1]).toBeCloseTo(0.25, 12);
    expect(many[2]).toBeCloseTo(0.15, 12);
    // Weights that don't sum to 1 are normalised too.
    expect(prizeSplit(2, [3, 1])).toEqual([0.75, 0.25]);
  });

  it("falls back to an even split instead of dividing by zero", () => {
    expect(prizeSplit(2, [0, 0])).toEqual([0.5, 0.5]);
  });

  it("0 eligible: nobody wins and the pool rolls over", () => {
    expect(weeklyPrizeWinners([], 100, split)).toEqual([]);
    const ineligible = [candidate("idle", 0.5, { isIdle: true }), candidate("broke", 0.9, { netWorthStart: 0 })];
    expect(weeklyPrizeWinners(ineligible, 100, split)).toEqual([]);
  });

  it("1 eligible: they take the whole pool", () => {
    const winners = weeklyPrizeWinners([candidate("a", 0.1), candidate("idle", 0.5, { isIdle: true })], 100, split);
    expect(winners).toEqual([{ playerId: "a", name: "A", growth: 0.1, prizeAmount: 100 }]);
  });

  it("2 eligible: first two shares rescaled, whole pool paid", () => {
    const winners = weeklyPrizeWinners([candidate("b", 0.02), candidate("a", 0.1)], 85, split);
    expect(winners.map((w) => w.playerId)).toEqual(["a", "b"]);
    expect(winners[0].prizeAmount).toBeCloseTo(60, 9);
    expect(winners[1].prizeAmount).toBeCloseTo(25, 9);
    expect(total(winners)).toBeCloseTo(85, 9);
  });

  it("3+ eligible: top three by growth get 60/25/15; the rest and ineligible players get nothing", () => {
    const winners = weeklyPrizeWinners(
      [
        candidate("d", -0.05),
        candidate("b", 0.04),
        candidate("idle", 0.9, { isIdle: true }),
        candidate("a", 0.08),
        candidate("broke", 0.7, { netWorthStart: 0 }),
        candidate("c", 0.01),
      ],
      200,
      split,
    );
    expect(winners.map((w) => w.playerId)).toEqual(["a", "b", "c"]);
    expect(winners.map((w) => w.growth)).toEqual([0.08, 0.04, 0.01]);
    expect(winners[0].prizeAmount).toBeCloseTo(120, 9);
    expect(winners[1].prizeAmount).toBeCloseTo(50, 9);
    expect(winners[2].prizeAmount).toBeCloseTo(30, 9);
    expect(total(winners)).toBeCloseTo(200, 9);
  });

  it("pays the full pool even when the shares don't divide it evenly", () => {
    const pool = 0.07;
    const winners = weeklyPrizeWinners([candidate("a", 3), candidate("b", 2), candidate("c", 1)], pool, [1, 1, 1]);
    expect(total(winners)).toBeCloseTo(pool, 15);
    for (const w of winners) expect(w.prizeAmount).toBeCloseTo(pool / 3, 12);
  });

  it("lists winners with £0 when the pool is empty", () => {
    const winners = weeklyPrizeWinners([candidate("a", 0.1), candidate("b", 0.05)], 0, split);
    expect(winners.map((w) => w.prizeAmount)).toEqual([0, 0]);
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
