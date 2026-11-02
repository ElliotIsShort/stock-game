/**
 * Fine-grained net-worth history: a point whenever a player's net worth
 * changes (their own trades, or a price move on something they hold or are
 * short). Stored one doc per player per week (`netWorthSeries/{uid}_{week}`)
 * so no document grows without bound and closed weeks are never rewritten.
 *
 * Writes are coalesced: within `netWorthTickMinutes` of the point that opened
 * the current window, the trailing point is overwritten (time and value), so
 * the chart always ends on the true current value but a busy market still
 * only adds about one point per window. Past the cap the older half is thinned.
 */
import type { NetWorthPoint, NetWorthSeries, NetWorthSeriesPoint } from "./types";

/** Points kept per player per week before the older half is downsampled. */
export const NET_WORTH_SERIES_MAX = 500;
/** How many recent weeks of series docs the client loads. */
export const NET_WORTH_SERIES_WEEKS = 8;

export function seriesDocId(uid: string, week: number): string {
  return `${uid}_${week}`;
}

/** Drop every other point in the older half (the newer half, incl. the latest point, is kept as-is). */
export function downsampleSeries(points: NetWorthSeriesPoint[], max = NET_WORTH_SERIES_MAX): NetWorthSeriesPoint[] {
  if (points.length <= max) return points;
  const half = Math.floor(points.length / 2);
  return [...points.slice(0, half).filter((_, i) => i % 2 === 0), ...points.slice(half)];
}

export interface SeriesState {
  points: NetWorthSeriesPoint[];
  /** When the trailing point's coalescing window opened (absent on a new doc). */
  openSince?: number;
}

/**
 * Add `p` to a series. Inside the open window the trailing point is replaced;
 * otherwise `p` is appended and opens a new window. A point older than the
 * trailing one (a late, out-of-order write) is ignored so the series never
 * ends on a stale value. `windowMs <= 0` disables coalescing.
 */
export function pushSeriesPoint(series: SeriesState, p: NetWorthSeriesPoint, windowMs: number, max = NET_WORTH_SERIES_MAX): SeriesState & { changed: boolean } {
  const points = series.points;
  const last = points.at(-1);
  if (last && p.t < last.t) return { ...series, changed: false };
  const open = series.openSince;
  if (last && open !== undefined && windowMs > 0 && p.t - open < windowMs) {
    if (last.v === p.v && last.t === p.t) return { ...series, changed: false };
    return { points: [...points.slice(0, -1), p], openSince: open, changed: true };
  }
  return { points: downsampleSeries([...points, p], max), openSince: p.t, changed: true };
}

/**
 * One chart series from the weekly close history (older ranges) and the
 * fine-grained series docs (recent weeks), oldest first. Weekly points are
 * only used before the first fine-grained point, so the two never interleave.
 */
export function mergeNetWorthPoints(weekly: NetWorthPoint[], series: Pick<NetWorthSeries, "points">[]): NetWorthSeriesPoint[] {
  const fine = series.flatMap((s) => s.points).sort((a, b) => a.t - b.t);
  const firstFine = fine[0]?.t ?? Number.POSITIVE_INFINITY;
  const older = weekly.filter((p) => p.t < firstFine).map((p) => ({ t: p.t, v: p.v }));
  return [...older, ...fine];
}
