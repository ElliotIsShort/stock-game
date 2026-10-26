/** Pure maths for the interactive chart. Kept separate from the component so it can be unit-tested. */

export interface ChartPoint {
  t: number;
  v: number;
}

export interface RangeOption {
  key: string;
  /** Window length in ms, or null for all data. */
  ms: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RANGE_OPTIONS: Record<string, RangeOption> = {
  "1D": { key: "1D", ms: DAY },
  "1W": { key: "1W", ms: 7 * DAY },
  "1M": { key: "1M", ms: 30 * DAY },
  "3M": { key: "3M", ms: 91 * DAY },
  "1Y": { key: "1Y", ms: 365 * DAY },
  All: { key: "All", ms: null },
};

/** Ranges worth offering: only windows shorter than the data, so each one shows something different from "All". */
export function availableRanges(points: ChartPoint[], keys: string[]): RangeOption[] {
  if (points.length < 2) return [RANGE_OPTIONS.All];
  const span = points[points.length - 1].t - points[0].t;
  const out = keys.map((k) => RANGE_OPTIONS[k]).filter((r): r is RangeOption => Boolean(r) && r.ms !== null && r.ms < span);
  return [...out, RANGE_OPTIONS.All];
}

/** Value at time t. `step` holds each value until the next point; otherwise linear. Points must be sorted by t. */
export function valueAt(points: ChartPoint[], t: number, step: boolean): number {
  const n = points.length;
  if (t <= points[0].t) return points[0].v;
  if (t >= points[n - 1].t) return points[n - 1].v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (step || b.t === a.t) return a.v;
  return a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v);
}

/** The points inside the last `ms` of the data, with a synthetic point at the window start. */
export function windowPoints(points: ChartPoint[], ms: number | null, step: boolean): ChartPoint[] {
  if (ms === null || points.length < 2) return points;
  const start = points[points.length - 1].t - ms;
  if (start <= points[0].t) return points;
  return [{ t: start, v: valueAt(points, start, step) }, ...points.filter((p) => p.t > start)];
}

/** Evenly spaced samples across the window, so every range has the same length and can morph 1:1. */
export function resample(points: ChartPoint[], n: number, step: boolean): number[] {
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  return Array.from({ length: n }, (_, k) => valueAt(points, t0 + (k / (n - 1)) * (t1 - t0), step));
}

/** Round axis bounds and evenly spaced tick values covering [min, max]. */
export function niceScale(min: number, max: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  if (!(max - min > 1e-9)) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

/** Index of the point whose time is closest to t. */
export function nearestIndex(points: ChartPoint[], t: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
  }
  return best;
}

export function easeOut(x: number): number {
  return 1 - (1 - x) ** 3;
}

/** Ease in-out (matches easyui's [0.77, 0, 0.175, 1] feel closely enough without a bezier solver). */
export function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}
