import { describe, expect, it } from "vitest";
import { NET_WORTH_SERIES_MAX, downsampleSeries, mergeNetWorthPoints, pushSeriesPoint, seriesDocId, type SeriesState } from "../src/netWorthSeries";

const MIN = 60_000;
const W = 5 * MIN;

function feed(times: number[], windowMs = W, max = NET_WORTH_SERIES_MAX): SeriesState {
  let s: SeriesState = { points: [] };
  for (const t of times) s = pushSeriesPoint(s, { t, v: t / MIN }, windowMs, max);
  return s;
}

describe("coalescing net-worth points", () => {
  it("appends the first point and opens a window", () => {
    const s = pushSeriesPoint({ points: [] }, { t: 0, v: 100 }, W);
    expect(s).toMatchObject({ points: [{ t: 0, v: 100 }], openSince: 0, changed: true });
  });

  it("overwrites the trailing point (time and value) inside the window", () => {
    const s = feed([0, 1 * MIN, 4 * MIN]);
    expect(s.points).toEqual([{ t: 4 * MIN, v: 4 }]);
    expect(s.openSince).toBe(0);
  });

  it("appends once the window has passed, and the chart ends on the latest value", () => {
    // A change every minute for 12 minutes: about one point per 5-minute window.
    const s = feed(Array.from({ length: 13 }, (_, i) => i * MIN));
    expect(s.points.map((p) => p.t / MIN)).toEqual([4, 9, 12]);
    expect(s.points.at(-1)).toEqual({ t: 12 * MIN, v: 12 });
  });

  it("ignores an out-of-order (older) point", () => {
    const s = feed([10 * MIN]);
    const late = pushSeriesPoint(s, { t: 9 * MIN, v: 1 }, W);
    expect(late.changed).toBe(false);
    expect(late.points).toEqual(s.points);
  });

  it("adds every change when the window is 0", () => {
    expect(feed([0, 1, 2], 0).points).toHaveLength(3);
  });

  it("reports no change for an identical point", () => {
    const s = feed([0, MIN]);
    expect(pushSeriesPoint(s, { t: MIN, v: 1 }, W).changed).toBe(false);
  });
});

describe("downsampling", () => {
  it("leaves short series alone", () => {
    const pts = Array.from({ length: 10 }, (_, t) => ({ t, v: t }));
    expect(downsampleSeries(pts, 10)).toBe(pts);
  });

  it("drops every other point in the older half and keeps the newer half intact", () => {
    const pts = Array.from({ length: 11 }, (_, t) => ({ t, v: t }));
    const out = downsampleSeries(pts, 10);
    expect(out.map((p) => p.t)).toEqual([0, 2, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("keeps a series under the cap no matter how many points arrive", () => {
    const s = feed(Array.from({ length: 2000 }, (_, i) => i * W), W, 500);
    expect(s.points.length).toBeLessThanOrEqual(500);
    expect(s.points.at(-1)!.t).toBe(1999 * W);
    expect(s.points[0].t).toBe(0);
    // Still chronological.
    expect(s.points.every((p, i) => i === 0 || p.t > s.points[i - 1].t)).toBe(true);
  });
});

describe("merging for the chart", () => {
  it("uses weekly close points only before the first fine-grained point", () => {
    const weekly = [
      { week: 1, t: 100, v: 1000 },
      { week: 2, t: 200, v: 1100 },
      { week: 3, t: 300, v: 1200 },
    ];
    const series = [{ points: [{ t: 310, v: 1210 }, { t: 400, v: 1300 }] }, { points: [{ t: 250, v: 1150 }, { t: 300, v: 1200 }] }];
    expect(mergeNetWorthPoints(weekly, series)).toEqual([
      { t: 100, v: 1000 },
      { t: 200, v: 1100 },
      { t: 250, v: 1150 },
      { t: 300, v: 1200 },
      { t: 310, v: 1210 },
      { t: 400, v: 1300 },
    ]);
    expect(mergeNetWorthPoints(weekly, [])).toHaveLength(3);
  });

  it("names docs per player per week", () => {
    expect(seriesDocId("abc", 7)).toBe("abc_7");
  });
});
