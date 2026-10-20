"use client";

import { gbp } from "@/lib/format";

export interface ChartPoint {
  t: number;
  v: number;
}

/**
 * Minimal dependency-free SVG line chart. Used for price history, net-worth
 * history and per-stock position value. `step` draws a step line (price holds
 * until the next trade); otherwise it's a straight line between points.
 */
export function LineChart({
  points,
  label,
  step = false,
  baseline,
}: {
  points: ChartPoint[];
  label: string;
  step?: boolean;
  /** Optional horizontal reference line (e.g. cost basis), drawn dashed. */
  baseline?: number;
}) {
  if (points.length < 2) return <p className="muted small">Not enough data to chart yet.</p>;
  const W = 600;
  const H = 180;
  const pad = 8;
  const ts = points.map((d) => d.t);
  const vs = points.map((d) => d.v);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (baseline !== undefined) {
    lo = Math.min(lo, baseline);
    hi = Math.max(hi, baseline);
  }
  const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);

  let d = `M ${x(points[0].t)} ${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) {
    if (step) d += ` H ${x(points[i].t)} V ${y(points[i].v)}`;
    else d += ` L ${x(points[i].t)} ${y(points[i].v)}`;
  }
  const up = vs[vs.length - 1] >= vs[0];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: from ${gbp(vs[0])} to ${gbp(vs[vs.length - 1])}, range ${gbp(lo)}–${gbp(hi)}`}>
        {baseline !== undefined && (
          <line x1={pad} x2={W - pad} y1={y(baseline)} y2={y(baseline)} stroke="var(--muted)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        )}
        <path d={d} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="small muted">
        Low {gbp(lo)} · High {gbp(hi)}
      </figcaption>
    </figure>
  );
}
