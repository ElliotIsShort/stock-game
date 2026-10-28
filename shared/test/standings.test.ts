import { describe, expect, it } from "vitest";
import { alertFires, validateAlert } from "../src/alerts";
import { recapTraders } from "../src/recap";
import { computeStandings } from "../src/standings";
import type { Player, Stock } from "../src/types";

function player(uid: string, cash: number, extra: Partial<Player> = {}): Player {
  return { uid, displayName: uid, cash, startingCash: 1000, totalAllowances: 0, isActive: true, isIdle: false, ...extra } as Player;
}
const stock = (id: string, price: number): Stock => ({ id, ownerId: id, price, listed: true, poolCash: price * 1000, poolShares: 1000 }) as Stock;

describe("computeStandings", () => {
  it("ranks active, non-idle players by score and leaves others unranked", () => {
    const players = [player("a", 900), player("b", 1200), player("c", 5000, { isIdle: true }), player("d", 100, { isActive: false })];
    const s = computeStandings(players, [stock("a", 50)], [{ uid: "a", stockId: "a", shares: 10, updatedAt: 0 }], [], 0.015);
    expect(s.get("a")).toMatchObject({ netWorth: 1400, holdingsValue: 500, rank: 1 });
    expect(s.get("b")?.rank).toBe(2);
    expect(s.get("c")?.rank).toBeNull();
    expect(s.get("d")?.rank).toBeNull();
  });
});

describe("price alerts", () => {
  it("must point away from the current price", () => {
    expect(validateAlert("below", 40, 50)).toEqual({ ok: true });
    expect(validateAlert("below", 60, 50)).toMatchObject({ ok: false });
    expect(validateAlert("above", 50, 50)).toMatchObject({ ok: false });
    expect(validateAlert("sideways", 50, 50)).toMatchObject({ ok: false });
    expect(validateAlert("above", -1, 50)).toMatchObject({ ok: false });
  });

  it("fires when the price reaches the target", () => {
    expect(alertFires({ direction: "below", price: 40, status: "active" }, 40)).toBe(true);
    expect(alertFires({ direction: "below", price: 40, status: "active" }, 41)).toBe(false);
    expect(alertFires({ direction: "above", price: 60, status: "active" }, 61)).toBe(true);
    expect(alertFires({ direction: "above", price: 60, status: "triggered" }, 61)).toBe(false);
  });
});

describe("recapTraders", () => {
  it("groups trades on your stock by trader, biggest first", () => {
    const rows = recapTraders([
      { traderId: "k", traderName: "Kalen", side: "buy", cashAmount: 100 },
      { traderId: "j", traderName: "James", side: "sell", kind: "openShort", cashAmount: 300 },
      { traderId: "k", traderName: "Kalen", side: "sell", cashAmount: 40 },
    ]);
    expect(rows).toEqual([
      { traderId: "j", traderName: "James", bought: 0, sold: 0, shorted: 300, covered: 0 },
      { traderId: "k", traderName: "Kalen", bought: 100, sold: 40, shorted: 0, covered: 0 },
    ]);
  });
});
