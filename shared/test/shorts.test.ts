import { describe, expect, it } from "vitest";
import { quoteBuy, quoteSell } from "../src/amm";
import { quoteCloseShort, quoteOpenShort, shortBorrowFee, shortUnrealised, shortableCapital } from "../src/shorts";

const pool = { poolCash: 4000, poolShares: 80 }; // price £50

describe("opening a short", () => {
  it("is the same as selling into the pool", () => {
    const short = quoteOpenShort(pool, 10, 0.015);
    const sell = quoteSell(pool, 10, 0.015);
    expect(short.proceeds).toBeCloseTo(sell.netCash, 9);
    expect(short.priceAfter).toBeCloseTo(sell.priceAfter, 9);
    expect(short.priceAfter).toBeLessThan(short.priceBefore); // price falls
  });
});

describe("closing a short", () => {
  it("buys the shares back and raises the price", () => {
    const open = quoteOpenShort(pool, 10, 0.015);
    const after = { poolCash: open.newPoolCash, poolShares: open.newPoolShares };
    const close = quoteCloseShort(after, 10, 0.015);
    expect(close.priceAfter).toBeCloseTo(50, 6); // back to the start
    expect(close.newPoolShares).toBeCloseTo(80, 6);
  });

  it("extracts exactly the shares, with the fee added on top like a buy", () => {
    const close = quoteCloseShort(pool, 5, 0.02);
    // The pool share count drops by exactly the shares bought back.
    expect(close.newPoolShares).toBeCloseTo(75, 9);
    // Cost matches a buy sized to move the pool the same way.
    const equivalentBuy = quoteBuy(pool, close.cost, 0.02);
    expect(equivalentBuy.shares).toBeCloseTo(5, 6);
  });

  it("refuses to close more shares than the pool holds", () => {
    expect(() => quoteCloseShort(pool, 80, 0.015)).toThrow();
    expect(() => quoteCloseShort(pool, 100, 0.015)).toThrow();
  });
});

describe("short P/L", () => {
  it("profits when the price falls between open and close", () => {
    // Open 10 short at £50, price drifts down, buy back cheaper.
    const open = quoteOpenShort(pool, 10, 0); // proceeds ~ £441
    // Simulate someone else selling the pool down before we close.
    const lower = quoteSell({ poolCash: open.newPoolCash, poolShares: open.newPoolShares }, 20, 0);
    const close = quoteCloseShort({ poolCash: lower.newPoolCash, poolShares: lower.newPoolShares }, 10, 0);
    const pnl = shortUnrealised({ openProceeds: open.proceeds, borrowFeesPaid: 0 }, close.cost);
    expect(pnl).toBeGreaterThan(0);
  });

  it("loses when the price rises, and borrow fees reduce the result", () => {
    const open = quoteOpenShort(pool, 10, 0);
    const higher = quoteBuy({ poolCash: open.newPoolCash, poolShares: open.newPoolShares }, 500, 0);
    const close = quoteCloseShort({ poolCash: higher.newPoolCash, poolShares: higher.newPoolShares }, 10, 0);
    const noFee = shortUnrealised({ openProceeds: open.proceeds, borrowFeesPaid: 0 }, close.cost);
    const withFee = shortUnrealised({ openProceeds: open.proceeds, borrowFeesPaid: 20 }, close.cost);
    expect(noFee).toBeLessThan(0);
    expect(withFee).toBeCloseTo(noFee - 20, 6);
  });

  it("a full open→close round trip with no price move loses only the fees", () => {
    const open = quoteOpenShort(pool, 10, 0.015);
    const close = quoteCloseShort({ poolCash: open.newPoolCash, poolShares: open.newPoolShares }, 10, 0.015);
    const pnl = shortUnrealised({ openProceeds: open.proceeds, borrowFeesPaid: 0 }, close.cost);
    expect(pnl).toBeLessThan(0); // the two fees
    expect(pnl).toBeGreaterThan(-30);
  });
});

describe("helpers", () => {
  it("capital excludes short paper gains", () => {
    expect(shortableCapital(1000, 500)).toBe(1500);
  });
  it("borrow fee is a fraction of the short's current value", () => {
    expect(shortBorrowFee(10, 50, 0.02)).toBeCloseTo(10, 9);
  });
});
