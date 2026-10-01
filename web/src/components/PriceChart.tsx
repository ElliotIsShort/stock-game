"use client";

import { gbp } from "@/lib/format";

/** Minimal dependency-free SVG line chart of price over time. */
export function PriceChart({ points, label }: { points: { t: number; p: number }[]; label: string }) {
  if (points.length < 2) return <p className="muted small">Not enough trades to chart yet.</p>;
  const W = 600;
  const H = 180;
  const pad = 8;
  const ts = points.map((d) => d.t);
  const ps = points.map((d) => d.p);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * pad);
  const y = (p: number) => H - pad - ((p - lo) / (hi - lo || 1)) * (H - 2 * pad);
  // Step line: price holds until the next trade.
  let d = `M ${x(points[0].t)} ${y(points[0].p)}`;
  for (let i = 1; i < points.length; i++) d += ` H ${x(points[i].t)} V ${y(points[i].p)}`;
  const up = ps[ps.length - 1] >= ps[0];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: from ${gbp(ps[0])} to ${gbp(ps[ps.length - 1])}, range ${gbp(lo)}–${gbp(hi)}`}>
        <path d={d} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="small muted">
        Low {gbp(lo)} · High {gbp(hi)}
      </figcaption>
    </figure>
  );
}
