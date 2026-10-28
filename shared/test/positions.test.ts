import { describe, expect, it } from "vitest";
import { positionFromTrades } from "../src/positions";
import type { Trade } from "../src/types";

/** Minimal Trade builder; only the fields positionFromTrades reads matter. */
let seq = 0;
function buy(shares: number, netSpent: number): Trade {
  return { side: "buy", shares, netCash: -netSpent, createdAt: ++seq, priceAfter: 0 } as Trade;
}
function sell(shares: number): Trade {
  return { side: "sell", shares, netCash: 0, createdAt: ++seq, priceAfter: 0 } as Trade;
}

describe("positionFromTrades (unrealised P/L)", () => {
  it("is empty with no trades", () => {
    const p = positionFromTrades([], 50);
    expect(p).toMatchObject({ shares: 0, costBasis: 0, avgCost: 0, marketValue: 0, unrealised: 0, unrealisedPct: 0 });
  });

  it("marks a single buy against the current price", () => {
    // Spent £100 (fee included) for 2 shares → avg cost £50. Now worth £60 each.
    const p = positionFromTrades([buy(2, 100)], 60);
    expect(p.shares).toBe(2);
    expect(p.avgCost).toBeCloseTo(50, 9);
    expect(p.marketValue).toBeCloseTo(120, 9);
    expect(p.unrealised).toBeCloseTo(20, 9);
    expect(p.unrealisedPct).toBeCloseTo(0.2, 9);
  });

  it("shows a loss when the price falls below average cost", () => {
    const p = positionFromTrades([buy(10, 500)], 40); // avg £50, now £40
    expect(p.unrealised).toBeCloseTo(-100, 9);
    expect(p.unrealisedPct).toBeCloseTo(-0.2, 9);
  });

  it("averages cost across multiple buys", () => {
    // 2 @ £50 then 2 @ £150 → 4 shares, cost £400, avg £100.
    const p = positionFromTrades([buy(2, 100), buy(2, 300)], 120);
    expect(p.shares).toBe(4);
    expect(p.avgCost).toBeCloseTo(100, 9);
    expect(p.unrealised).toBeCloseTo(4 * 120 - 400, 9);
  });

  it("a partial sell leaves the average cost of the remainder unchanged", () => {
    // Buy 4 @ avg £100 (cost £400), sell 1 → 3 left, cost £300, avg still £100.
    const p = positionFromTrades([buy(4, 400), sell(1)], 100);
    expect(p.shares).toBe(3);
    expect(p.costBasis).toBeCloseTo(300, 9);
    expect(p.avgCost).toBeCloseTo(100, 9);
    expect(p.unrealised).toBeCloseTo(0, 9);
  });

  it("selling everything flattens the position", () => {
    const p = positionFromTrades([buy(4, 400), sell(4)], 100);
    expect(p.shares).toBe(0);
    expect(p.costBasis).toBe(0);
    expect(p.unrealised).toBe(0);
  });

  it("tracks realised P/L from sells", () => {
    // Buy 4 for £400 (avg £100); sell 2 for £260 net → +£60 realised.
    const b = buy(4, 400);
    const s = { side: "sell", shares: 2, netCash: 260, createdAt: ++seq, priceAfter: 0 } as Trade;
    const p = positionFromTrades([b, s], 100);
    expect(p.realised).toBeCloseTo(60, 9);
    expect(p.costBasis).toBeCloseTo(200, 9);
  });

  it("ignores short opens and covers (they don't touch holdings)", () => {
    const b = buy(2, 100);
    const short = { side: "sell", kind: "openShort", shares: 5, netCash: 250, createdAt: ++seq } as Trade;
    const cover = { side: "buy", kind: "closeShort", shares: 5, netCash: -200, createdAt: ++seq } as Trade;
    const p = positionFromTrades([b, short, cover], 50);
    expect(p.shares).toBe(2);
    expect(p.costBasis).toBeCloseTo(100, 9);
    expect(p.realised).toBe(0);
  });

  it("restarts the holding run on any sell", () => {
    const b = buy(4, 400);
    const s = sell(1);
    expect(positionFromTrades([b], 100).holdingSince).toBe(b.createdAt);
    expect(positionFromTrades([b, s], 100).holdingSince).toBe(s.createdAt);
    const b2 = buy(4, 400);
    expect(positionFromTrades([b2, sell(4)], 100).holdingSince).toBeNull();
  });

  it("ignores trade order (sorts by time)", () => {
    const b1 = buy(2, 100);
    const b2 = buy(2, 300);
    const forward = positionFromTrades([b1, b2], 120);
    const reversed = positionFromTrades([b2, b1], 120);
    expect(reversed).toEqual(forward);
  });
});
