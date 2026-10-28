import { describe, expect, it } from "vitest";
import { RECENT_PRICES_MAX, holdingAfterBuy, holdingAfterSell, priceTick } from "../src/stockStats";

const base = { price: 50, listPrice: 50, weekHigh: 55, weekLow: 45, weekOpenPrice: 50, listedWeek: 1 };

describe("priceTick", () => {
  it("initialises records from what we know and never announces on that tick", () => {
    const t = priceTick(base, 60, 3);
    expect(t.patch).toMatchObject({ allTimeHigh: 60, allTimeLow: 45, recentPrices: [50, 60] });
    expect(t.announceHigh).toBe(false);
  });

  it("announces a new record once per week, only after the first close", () => {
    const seasoned = { ...base, allTimeHigh: 55, allTimeLow: 45 };
    const t = priceTick(seasoned, 60, 3);
    expect(t.announceHigh).toBe(true);
    expect(t.patch.athAnnouncedWeek).toBe(3);
    expect(priceTick({ ...seasoned, athAnnouncedWeek: 3 }, 61, 3).announceHigh).toBe(false);
    expect(priceTick({ ...seasoned, atlAnnouncedWeek: 2 }, 40, 3).announceLow).toBe(true);
    // Listed this week: no announcements yet.
    expect(priceTick({ ...seasoned, listedWeek: 3 }, 60, 3).announceHigh).toBe(false);
    expect(priceTick(seasoned, 52, 3)).toMatchObject({ announceHigh: false, announceLow: false });
  });

  it("keeps a bounded list of recent prices", () => {
    const prices = Array.from({ length: RECENT_PRICES_MAX }, (_, i) => i + 1);
    const t = priceTick({ ...base, recentPrices: prices }, 99, 2);
    expect(t.recentPrices).toHaveLength(RECENT_PRICES_MAX);
    expect(t.recentPrices.at(-1)).toBe(99);
    expect(t.recentPrices[0]).toBe(2);
  });
});

describe("holding bookkeeping", () => {
  it("adds cost on buys and keeps the run going", () => {
    const first = holdingAfterBuy(null, 2, 100, 10);
    expect(first).toEqual({ shares: 2, costBasis: 100, holdingSince: 10 });
    expect(holdingAfterBuy(first, 1, 60, 20)).toEqual({ shares: 3, costBasis: 160, holdingSince: 10 });
  });

  it("removes shares at average cost and restarts the run on sells", () => {
    expect(holdingAfterSell({ shares: 4, costBasis: 400 }, 1, 30)).toEqual({ shares: 3, costBasis: 300, holdingSince: 30 });
    expect(holdingAfterSell({ shares: 4, costBasis: 400 }, 4, 30).shares).toBe(0);
  });
});
