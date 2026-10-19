import { describe, expect, it } from "vitest";
import { listingPool, poolPrice, quoteBuy, quoteSell, targetPoolCash, topUpPool } from "../src/amm";

// Worked example from the design doc §2: C = £4,000, S = 80 shares, price £50.
const pool = { poolCash: 4000, poolShares: 80 };

describe("quoteBuy", () => {
  it("matches the design doc's £100 buy (no fee)", () => {
    const q = quoteBuy(pool, 100, 0);
    expect(q.priceAfter).toBeCloseTo(52.53, 2);
    expect(q.priceAfter / q.priceBefore - 1).toBeCloseTo(0.0506, 3);
  });

  it("follows the formula for the £500 buy (£63.28, the doc's £64.00 is a typo)", () => {
    expect(quoteBuy(pool, 500, 0).priceAfter).toBeCloseTo(63.28, 2);
  });

  it("keeps k constant and pays out S − k/C'", () => {
    const q = quoteBuy(pool, 250, 0);
    expect(q.newPoolCash * q.newPoolShares).toBeCloseTo(4000 * 80, 6);
    expect(q.shares).toBeCloseTo(80 - (4000 * 80) / 4250, 9);
  });

  it("takes the fee off the top before the pool math", () => {
    const q = quoteBuy(pool, 100, 0.015);
    expect(q.fee).toBeCloseTo(1.5, 9);
    expect(q.netToPool).toBeCloseTo(98.5, 9);
    expect(q.newPoolCash).toBeCloseTo(4098.5, 9);
    // Same result as a fee-free buy of the net amount.
    expect(q.shares).toBeCloseTo(quoteBuy(pool, 98.5, 0).shares, 9);
  });

  it("supports fractional shares when a share costs more than the trade", () => {
    const pricey = { poolCash: 8500, poolShares: 100 }; // £85/share
    const q = quoteBuy(pricey, 10, 0);
    expect(q.shares).toBeGreaterThan(0);
    expect(q.shares).toBeLessThan(1);
  });

  it("rejects non-positive amounts and empty pools", () => {
    expect(() => quoteBuy(pool, 0, 0)).toThrow();
    expect(() => quoteBuy(pool, -5, 0)).toThrow();
    expect(() => quoteBuy(pool, Number.NaN, 0)).toThrow();
    expect(() => quoteBuy({ poolCash: 0, poolShares: 10 }, 10, 0)).toThrow();
  });
});

describe("quoteSell", () => {
  it("matches the design doc's 10-share sell (no fee)", () => {
    expect(quoteSell(pool, 10, 0).priceAfter).toBeCloseTo(39.51, 2);
  });

  it("deducts the fee from the cash paid out", () => {
    const gross = quoteSell(pool, 10, 0).grossCash;
    const q = quoteSell(pool, 10, 0.02);
    expect(q.grossCash).toBeCloseTo(gross, 9);
    expect(q.fee).toBeCloseTo(gross * 0.02, 9);
    expect(q.netCash).toBeCloseTo(gross * 0.98, 9);
  });

  it("round-trips: selling the shares you just bought returns the pool to where it was", () => {
    const buy = quoteBuy(pool, 300, 0);
    const after = { poolCash: buy.newPoolCash, poolShares: buy.newPoolShares };
    const sell = quoteSell(after, buy.shares, 0);
    expect(sell.newPoolCash).toBeCloseTo(4000, 6);
    expect(sell.newPoolShares).toBeCloseTo(80, 6);
    expect(sell.netCash).toBeCloseTo(300, 6);
  });

  it("loses money on a round trip once fees apply", () => {
    const buy = quoteBuy(pool, 300, 0.015);
    const sell = quoteSell({ poolCash: buy.newPoolCash, poolShares: buy.newPoolShares }, buy.shares, 0.015);
    expect(sell.netCash).toBeLessThan(300);
  });
});

describe("pool depth (§2.1)", () => {
  it("sizes the pool so a target-size buy moves price by the target impact", () => {
    const avgNetWorth = 1200;
    const cash = targetPoolCash(avgNetWorth, 0.1, 0.05);
    const p = listingPool(avgNetWorth, 50, 0.1, 0.05);
    expect(p.poolCash).toBeCloseTo(cash, 9);
    expect(poolPrice(p)).toBeCloseTo(50, 9);
    const q = quoteBuy(p, 0.1 * avgNetWorth, 0);
    expect(q.priceAfter / q.priceBefore - 1).toBeCloseTo(0.05, 9);
  });

  it("tops up a shallow pool without changing price", () => {
    const t = topUpPool(pool, 6000);
    expect(t.addCash).toBeCloseTo(2000, 9);
    expect(t.addShares).toBeCloseTo(40, 9);
    expect(t.newPoolCash / t.newPoolShares).toBeCloseTo(50, 9);
  });

  it("never shrinks a pool that's already deep enough", () => {
    const t = topUpPool(pool, 1000);
    expect(t.addCash).toBe(0);
    expect(t.newPoolCash).toBe(4000);
    expect(t.newPoolShares).toBe(80);
  });
});
