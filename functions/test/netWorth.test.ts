import { beforeEach, describe, expect, it } from "vitest";
import { call, clientRead, getDoc, listDocs, setupPlayers, sleep, waitFor, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
let cara: User;
let dave: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara, dave] = await setupPlayers("Alice", "Bob", "Cara", "Dave");
});

const series = (u: User, week = 1) => getDoc(`netWorthSeries/${u.uid}_${week}`);

/** Net worth as the server defines it, from the docs (no shorts held by `u`). */
async function netWorthOf(u: User): Promise<number> {
  const p = await getDoc(`players/${u.uid}`);
  const holdings = (await listDocs("holdings")).filter((h) => h.uid === u.uid);
  let v = p.cash;
  for (const h of holdings) v += h.shares * (await getDoc(`stocks/${h.stockId}`)).price;
  return v;
}

/** Wait until the series ends on `v` (the trigger is asynchronous). */
async function seriesEndingOn(u: User, v: number) {
  return waitFor(async () => {
    const s = await series(u);
    return s && Math.abs(s.points.at(-1).v - v) < 1e-6 ? s : undefined;
  }, 15_000, `${u.email}'s series to end on ${v}`);
}

describe("net-worth series", () => {
  it("records a point for the trader and for holders and short-sellers of the traded stock", async () => {
    await call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 200 });
    const caraFirst = await seriesEndingOn(cara, await netWorthOf(cara));
    expect(caraFirst).toMatchObject({ uid: cara.uid, week: 1 });
    expect(caraFirst.points).toHaveLength(1);

    // Dave shorts Bob: Bob's price falls, so Cara (a holder) and Dave (the trader) both move.
    await call(dave, "openShort", { stockId: bob.uid, shares: 2 });
    const caraNow = await netWorthOf(cara);
    expect(caraNow).toBeLessThan(caraFirst.points[0].v);
    await seriesEndingOn(cara, caraNow);
    const daveSeries = await waitFor(() => series(dave), 15_000, "Dave's series");
    // An open short never raises net worth: Dave is down by about the fees.
    expect(daveSeries.points.at(-1).v).toBeLessThan(1000);
    expect(daveSeries.points.at(-1).v).toBeGreaterThan(990);

    // Bob's own stock moved but he holds nothing, and Alice wasn't involved.
    await sleep(1000);
    expect(await series(bob)).toBeNull();
    expect(await series(alice)).toBeNull();
  });

  it("overwrites the latest point inside the window, and appends outside it", async () => {
    await call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    await seriesEndingOn(cara, await netWorthOf(cara));
    await call(dave, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    const within = await seriesEndingOn(cara, await netWorthOf(cara));
    // Default window is 5 minutes: still one point, now carrying the new value.
    expect(within.points).toHaveLength(1);

    await call(alice, "updateConfig", { patch: { netWorthTickMinutes: 0 } });
    await call(dave, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    const outside = await seriesEndingOn(cara, await netWorthOf(cara));
    expect(outside.points).toHaveLength(2);
    expect(outside.points[1].t).toBeGreaterThan(outside.points[0].t);
  });

  it("appends the closing value at the weekly close, and the next week starts a new doc", async () => {
    await call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    await seriesEndingOn(cara, await netWorthOf(cara));
    await call(alice, "runWeeklyClose", { expectedWeek: 1 });
    const closed = await series(cara);
    const p = await getDoc(`players/${cara.uid}`);
    expect(closed.points.at(-1).v).toBeCloseTo(p.netWorthWeekStart, 6);
    // Everyone active gets the close point, even without a trade.
    expect((await series(alice)).points).toHaveLength(1);

    await call(dave, "trade", { stockId: bob.uid, side: "buy", amount: 50 });
    const week2 = await waitFor(() => series(cara, 2), 15_000, "week 2 series");
    expect(week2.points).toHaveLength(1);
    expect((await series(cara)).points).toHaveLength(closed.points.length);
  });

  it("never writes to stocks, so it can't retrigger itself", async () => {
    await call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    await seriesEndingOn(cara, await netWorthOf(cara));
    const stock = await getDoc(`stocks/${bob.uid}`);
    const before = await series(cara);
    await sleep(2000);
    expect(await getDoc(`stocks/${bob.uid}`)).toEqual(stock);
    expect(await series(cara)).toEqual(before);
  });

  it("ignores stock updates that aren't trades (e.g. a ticker change)", async () => {
    await call(bob, "setTicker", { ticker: "BOBBY" });
    await sleep(1500);
    expect((await listDocs("netWorthSeries")).filter((s) => [alice, bob, cara, dave].some((u) => u.uid === s.uid))).toEqual([]);
  });

  it("is readable by members, like netWorthHistory", async () => {
    await call(cara, "trade", { stockId: bob.uid, side: "buy", amount: 100 });
    await waitFor(() => series(cara), 15_000, "Cara's series");
    expect(await clientRead(dave, `netWorthSeries/${cara.uid}_1`)).toBe(200);
  });
});
