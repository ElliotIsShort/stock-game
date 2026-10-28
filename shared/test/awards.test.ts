import { describe, expect, it } from "vitest";
import { badgesFor, computeAwards, type AwardInputs } from "../src/awards";

const DAY = 86_400_000;
const now = 30 * DAY;
const names: Record<string, string> = { a: "Alice", b: "Bob", c: "Cara" };

function inputs(over: Partial<AwardInputs> = {}): AwardInputs {
  return {
    weekStartedAt: now - 7 * DAY,
    now,
    nameOf: (uid) => names[uid],
    tickerOf: (id) => id.toUpperCase().repeat(3),
    stocks: [
      { id: "a", name: "Alice", weekOpenPrice: 50, price: 55 },
      { id: "b", name: "Bob", weekOpenPrice: 50, price: 30 },
      { id: "c", name: "Cara", weekOpenPrice: 50, price: 50 },
    ],
    holdings: [
      { uid: "a", stockId: "b", shares: 10, costBasis: 500, holdingSince: now - 20 * DAY, price: 30 },
      { uid: "c", stockId: "a", shares: 2, costBasis: 100, holdingSince: now - 3 * DAY, price: 55 },
    ],
    posts: [
      { id: "p1", authorId: "b", text: "Buy Alice", reactionCount: 3, down: 0, createdAt: 1 },
      { id: "p2", authorId: "c", text: "Bob to the moon", reactionCount: 3, down: 2, createdAt: 2 },
    ],
    ...over,
  };
}

describe("weekly awards", () => {
  it("picks each award by the agreed definition", () => {
    const awards = Object.fromEntries(computeAwards(inputs()).map((a) => [a.key, a]));
    // Bob fell 40%, a bigger move than Alice's +10%.
    expect(awards.biggestMover).toMatchObject({ playerId: "b", detail: "-40.0% ($BBB)" });
    // Alice is down £200 on Bob.
    expect(awards.bagHolder).toMatchObject({ playerId: "a", value: 200, detail: "down £200.00 on $BBB (-40.0%)" });
    // Alice has held since before the week; Cara only bought 3 days ago.
    expect(awards.diamondHands).toMatchObject({ playerId: "a", value: 20, detail: "held $BBB for 20 days without selling" });
    // Tied on reactions: the earlier post wins.
    expect(awards.mostReacted).toMatchObject({ playerId: "b", postId: "p1" });
    expect(awards.worstTake).toMatchObject({ playerId: "c", postId: "p2", value: 2 });
  });

  it("skips awards nobody qualifies for", () => {
    const awards = computeAwards(inputs({ stocks: [], holdings: [], posts: [] }));
    expect(awards).toEqual([]);
  });

  it("ignores dust holdings and players who've left", () => {
    const awards = computeAwards(
      inputs({
        holdings: [
          { uid: "a", stockId: "b", shares: 0.001, costBasis: 500, holdingSince: 0, price: 30 },
          { uid: "zed", stockId: "b", shares: 10, costBasis: 500, holdingSince: 0, price: 30 },
        ],
      }),
    );
    expect(awards.find((a) => a.key === "bagHolder")).toBeUndefined();
    expect(awards.find((a) => a.key === "diamondHands")).toBeUndefined();
  });

  it("turns reports into profile badges", () => {
    const awards = computeAwards(inputs());
    const badges = badgesFor(
      "a",
      [
        { week: 1, winners: [{ playerId: "a" }, { playerId: "b" }], awards },
        { week: 2, winners: [{ playerId: "b" }, { playerId: "a" }] },
      ],
      1,
    );
    const byKey = Object.fromEntries(badges.map((b) => [b.key, b]));
    expect(byKey.weeklyWin).toMatchObject({ count: 1, weeks: [1] });
    expect(byKey.podium).toMatchObject({ count: 1, weeks: [2] });
    expect(byKey.bagHolder.count).toBe(1);
    expect(byKey.founder).toBeDefined();
  });
});
