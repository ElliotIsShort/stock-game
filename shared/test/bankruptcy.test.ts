import { describe, expect, it } from "vitest";
import { settleDebt, type Creditor, type DebtorHolding } from "../src/bankruptcy";

// A deep pool so liquidation barely moves the price (keeps the arithmetic clean).
const pool = (price: number) => ({ poolCash: price * 1_000_000, poolShares: 1_000_000 });
function holding(stockId: string, shares: number, price: number): DebtorHolding {
  return { stockId, shares, pool: pool(price) };
}

describe("settleDebt", () => {
  it("pays in full from cash alone when solvent, debtor keeps the change", () => {
    const r = settleDebt(500, [], 300, [{ uid: "c1", owed: 300 }], 0);
    expect(r.bankrupt).toBe(false);
    expect(r.shortfall).toBe(0);
    expect(r.remainingCash).toBe(200);
    expect(r.payouts).toEqual([{ uid: "c1", owed: 300, paid: 300 }]);
  });

  it("liquidates holdings to cover a debt cash alone can't", () => {
    // £100 cash + ~£400 from selling 10 @ £40 → covers £300.
    const r = settleDebt(100, [holding("alice", 10, 40)], 300, [{ uid: "c1", owed: 300 }], 0);
    expect(r.sales).toHaveLength(1);
    expect(r.sales[0].cash).toBeGreaterThan(395);
    expect(r.bankrupt).toBe(false);
    expect(r.remainingCash).toBeGreaterThan(190);
  });

  it("goes bankrupt when cash + liquidation falls short", () => {
    const r = settleDebt(50, [holding("alice", 1, 40)], 1000, [{ uid: "c1", owed: 1000 }], 0);
    expect(r.bankrupt).toBe(true);
    expect(r.remainingCash).toBe(0);
    expect(r.shortfall).toBeGreaterThan(0);
    // The one creditor gets everything that was raised.
    expect(r.payouts[0].paid).toBeCloseTo(r.raised, 2);
  });

  it("splits proportionally to what each creditor is owed", () => {
    // Raise exactly £550 from cash, owe £1000 + £100.
    const r = settleDebt(550, [], 1100, [{ uid: "big", owed: 1000 }, { uid: "small", owed: 100 }], 0);
    expect(r.bankrupt).toBe(true);
    const big = r.payouts.find((p) => p.uid === "big")!;
    const small = r.payouts.find((p) => p.uid === "small")!;
    expect(big.paid).toBeCloseTo(500, 2); // 1000/1100 × 550
    expect(small.paid).toBeCloseTo(50, 2); // 100/1100 × 550
    // Everything raised is handed out (shortfall is the creditors' loss).
    expect(big.paid + small.paid).toBeCloseTo(550, 2);
    expect(r.shortfall).toBeCloseTo(550, 2);
  });

  it("the shortfall is never clawed back — creditors simply lose it", () => {
    const r = settleDebt(0, [], 1000, [{ uid: "c1", owed: 1000 }], 0);
    expect(r.raised).toBe(0);
    expect(r.payouts[0].paid).toBe(0);
    expect(r.shortfall).toBe(1000);
    expect(r.bankrupt).toBe(true);
  });

  it("applies the trading fee to liquidation sales", () => {
    const noFee = settleDebt(0, [holding("a", 10, 50)], 10_000, [{ uid: "c", owed: 10_000 }], 0);
    const withFee = settleDebt(0, [holding("a", 10, 50)], 10_000, [{ uid: "c", owed: 10_000 }], 0.1);
    expect(withFee.raised).toBeLessThan(noFee.raised);
  });

  it("handles multiple creditors' rounding without losing a penny", () => {
    const creditors: Creditor[] = [
      { uid: "a", owed: 333 },
      { uid: "b", owed: 333 },
      { uid: "c", owed: 334 },
    ];
    const r = settleDebt(100, [], 1000, creditors, 0);
    const total = r.payouts.reduce((s, p) => s + p.paid, 0);
    expect(total).toBeCloseTo(100, 2);
  });
});
